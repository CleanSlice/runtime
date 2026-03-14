export interface AgentFile {
  path: string
  content: string
}

export interface AgentConfig {
  soul?: string
  user?: string
  memory?: string
  heartbeat?: string
  skills: string[]
}
