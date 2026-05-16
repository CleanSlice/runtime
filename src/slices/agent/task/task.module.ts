import { TaskManager } from "./domain/task.service"
import { TaskGateway } from "./data/task.gateway"

export { TaskManager, type Task } from "./domain/task.service"
export type { ITask, TaskStatus } from "./domain/task.types"
export type { ITaskGateway } from "./domain/task.gateway"

export class TaskModule {
  readonly manager: TaskManager

  constructor() {
    const gateway = new TaskGateway()
    this.manager = new TaskManager(gateway)
  }
}
