/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

/// <reference types="node" />

import * as cluster from 'cluster';

import {resolve} from '../../../../src/ngtsc/file_system';
import {Logger} from '../../logging/logger';
import {PackageJsonUpdater} from '../../writing/package_json_updater';
import {AnalyzeEntryPointsFn} from '../api';
import {CreateTaskCompletedCallback, Task, TaskCompletedCallback, TaskQueue} from '../tasks/api';
import {stringifyTask} from '../tasks/utils';

import {MessageFromWorker, TaskCompletedMessage, UpdatePackageJsonMessage} from './api';
import {Deferred, sendMessageToWorker} from './utils';


/**
 * The cluster master is responsible for analyzing all entry-points, planning the work that needs to
 * be done, distributing it to worker-processes and collecting/post-processing the results.
 */
export class ClusterMaster {
  private finishedDeferred = new Deferred<void>();
  private processingStartTime: number = -1;
  private taskAssignments = new Map<number, Task|null>();
  private taskQueue: TaskQueue;
  private onTaskCompleted: TaskCompletedCallback;

  constructor(
      private maxWorkerCount: number, private logger: Logger,
      private pkgJsonUpdater: PackageJsonUpdater, analyzeEntryPoints: AnalyzeEntryPointsFn,
      createTaskCompletedCallback: CreateTaskCompletedCallback) {
    if (!cluster.isMaster) {
      throw new Error('Tried to instantiate `ClusterMaster` on a worker process.');
    }

    this.taskQueue = analyzeEntryPoints();
    this.onTaskCompleted = createTaskCompletedCallback(this.taskQueue);
  }

  run(): Promise<void> {
    if (this.taskQueue.allTasksCompleted) {
      return Promise.resolve();
    }

    // Set up listeners for worker events (emitted on `cluster`).
    cluster.on('online', this.wrapEventHandler(worker => this.onWorkerOnline(worker.id)));

    cluster.on(
        'message', this.wrapEventHandler((worker, msg) => this.onWorkerMessage(worker.id, msg)));

    cluster.on(
        'exit',
        this.wrapEventHandler((worker, code, signal) => this.onWorkerExit(worker, code, signal)));

    // Since we have pending tasks at the very minimum we need a single worker.
    cluster.fork();

    return this.finishedDeferred.promise.then(() => this.stopWorkers(), err => {
      this.stopWorkers();
      return Promise.reject(err);
    });
  }

  /** Try to find available (idle) workers and assign them available (non-blocked) tasks. */
  private maybeDistributeWork(): void {
    let isWorkerAvailable = false;

    // First, check whether all tasks have been completed.
    if (this.taskQueue.allTasksCompleted) {
      const duration = Math.round((Date.now() - this.processingStartTime) / 100) / 10;
      this.logger.debug(`Processed tasks in ${duration}s.`);

      return this.finishedDeferred.resolve();
    }

    // Look for available workers and available tasks to assign to them.
    for (const [workerId, assignedTask] of Array.from(this.taskAssignments)) {
      if (assignedTask !== null) {
        // This worker already has a job; check other workers.
        continue;
      } else {
        // This worker is available.
        isWorkerAvailable = true;
      }

      // This worker needs a job. See if any are available.
      const task = this.taskQueue.getNextTask();
      if (task === null) {
        // No suitable work available right now.
        break;
      }

      // Process the next task on the worker.
      this.taskAssignments.set(workerId, task);
      sendMessageToWorker(workerId, {type: 'process-task', task});

      isWorkerAvailable = false;
    }

    if (!isWorkerAvailable) {
      const spawnedWorkerCount = Object.keys(cluster.workers).length;
      if (spawnedWorkerCount < this.maxWorkerCount) {
        this.logger.debug('Spawning another worker process as there is more work to be done.');
        cluster.fork();
      } else {
        // If there are no available workers or no available tasks, log (for debugging purposes).
        this.logger.debug(
            `All ${spawnedWorkerCount} workers are currently busy and cannot take on more work.`);
      }
    } else {
      const busyWorkers = Array.from(this.taskAssignments)
                              .filter(([_workerId, task]) => task !== null)
                              .map(([workerId]) => workerId);
      const totalWorkerCount = this.taskAssignments.size;
      const idleWorkerCount = totalWorkerCount - busyWorkers.length;

      this.logger.debug(
          `No assignments for ${idleWorkerCount} idle (out of ${totalWorkerCount} total) ` +
          `workers. Busy workers: ${busyWorkers.join(', ')}`);

      if (busyWorkers.length === 0) {
        // This is a bug:
        // All workers are idle (meaning no tasks are in progress) and `taskQueue.allTasksCompleted`
        // is `false`, but there is still no assignable work.
        throw new Error(
            'There are still unprocessed tasks in the queue and no tasks are currently in ' +
            `progress, yet the queue did not return any available tasks: ${this.taskQueue}`);
      }
    }
  }

  /** Handle a worker's exiting. (Might be intentional or not.) */
  private onWorkerExit(worker: cluster.Worker, code: number|null, signal: string|null): void {
    // If the worker's exiting was intentional, nothing to do.
    if (worker.exitedAfterDisconnect) return;

    // The worker exited unexpectedly: Determine it's status and take an appropriate action.
    const currentTask = this.taskAssignments.get(worker.id);

    this.logger.warn(
        `Worker #${worker.id} exited unexpectedly (code: ${code} | signal: ${signal}).\n` +
        `  Current assignment: ${(currentTask == null) ? '-' : stringifyTask(currentTask)}`);

    if (currentTask == null) {
      // The crashed worker process was not in the middle of a task:
      // Just spawn another process.
      this.logger.debug(`Spawning another worker process to replace #${worker.id}...`);
      this.taskAssignments.delete(worker.id);
      cluster.fork();
    } else {
      // The crashed worker process was in the middle of a task:
      // Impossible to know whether we can recover (without ending up with a corrupted entry-point).
      throw new Error(
          'Process unexpectedly crashed, while processing format property ' +
          `${currentTask.formatProperty} for entry-point '${currentTask.entryPoint.path}'.`);
    }
  }

  /** Handle a message from a worker. */
  private onWorkerMessage(workerId: number, msg: MessageFromWorker): void {
    if (!this.taskAssignments.has(workerId)) {
      const knownWorkers = Array.from(this.taskAssignments.keys());
      throw new Error(
          `Received message from unknown worker #${workerId} (known workers: ` +
          `${knownWorkers.join(', ')}): ${JSON.stringify(msg)}`);
    }

    switch (msg.type) {
      case 'error':
        throw new Error(`Error on worker #${workerId}: ${msg.error}`);
      case 'task-completed':
        return this.onWorkerTaskCompleted(workerId, msg);
      case 'update-package-json':
        return this.onWorkerUpdatePackageJson(workerId, msg);
      default:
        throw new Error(
            `Invalid message received from worker #${workerId}: ${JSON.stringify(msg)}`);
    }
  }

  /** Handle a worker's coming online. */
  private onWorkerOnline(workerId: number): void {
    if (this.taskAssignments.has(workerId)) {
      throw new Error(`Invariant violated: Worker #${workerId} came online more than once.`);
    }

    if (this.processingStartTime === -1) {
      this.logger.debug('Processing tasks...');
      this.processingStartTime = Date.now();
    }

    this.taskAssignments.set(workerId, null);
    this.maybeDistributeWork();
  }

  /** Handle a worker's having completed their assigned task. */
  private onWorkerTaskCompleted(workerId: number, msg: TaskCompletedMessage): void {
    const task = this.taskAssignments.get(workerId) || null;

    if (task === null) {
      throw new Error(
          `Expected worker #${workerId} to have a task assigned, while handling message: ` +
          JSON.stringify(msg));
    }

    this.onTaskCompleted(task, msg.outcome, msg.message);

    this.taskQueue.markTaskCompleted(task);
    this.taskAssignments.set(workerId, null);
    this.maybeDistributeWork();
  }

  /** Handle a worker's request to update a `package.json` file. */
  private onWorkerUpdatePackageJson(workerId: number, msg: UpdatePackageJsonMessage): void {
    const task = this.taskAssignments.get(workerId) || null;

    if (task === null) {
      throw new Error(
          `Expected worker #${workerId} to have a task assigned, while handling message: ` +
          JSON.stringify(msg));
    }

    const expectedPackageJsonPath = resolve(task.entryPoint.path, 'package.json');
    const parsedPackageJson = task.entryPoint.packageJson;

    if (expectedPackageJsonPath !== msg.packageJsonPath) {
      throw new Error(
          `Received '${msg.type}' message from worker #${workerId} for '${msg.packageJsonPath}', ` +
          `but was expecting '${expectedPackageJsonPath}' (based on task assignment).`);
    }

    // NOTE: Although the change in the parsed `package.json` will be reflected in tasks objects
    //       locally and thus also in future `process-task` messages sent to worker processes, any
    //       processes already running and processing a task for the same entry-point will not get
    //       the change.
    //       Do not rely on having an up-to-date `package.json` representation in worker processes.
    //       In other words, task processing should only rely on the info that was there when the
    //       file was initially parsed (during entry-point analysis) and not on the info that might
    //       be added later (during task processing).
    this.pkgJsonUpdater.writeChanges(msg.changes, msg.packageJsonPath, parsedPackageJson);
  }

  /** Stop all workers and stop listening on cluster events. */
  private stopWorkers(): void {
    const workers = Object.values(cluster.workers) as cluster.Worker[];
    this.logger.debug(`Stopping ${workers.length} workers...`);

    cluster.removeAllListeners();
    workers.forEach(worker => worker.kill());
  }

  /**
   * Wrap an event handler to ensure that `finishedDeferred` will be rejected on error (regardless
   * if the handler completes synchronously or asynchronously).
   */
  private wrapEventHandler<Args extends unknown[]>(fn: (...args: Args) => void|Promise<void>):
      (...args: Args) => Promise<void> {
    return async(...args: Args) => {
      try {
        await fn(...args);
      } catch (err) {
        this.finishedDeferred.reject(err);
      }
    };
  }
}
