export interface IHeartbeatGateway {
  exists(): boolean
  load(): Promise<string>
}
