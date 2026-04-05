/** Gateway for persisting voice mode state */
export interface IVoiceGateway {
  load(): string[]
  save(userIds: string[]): void
}
