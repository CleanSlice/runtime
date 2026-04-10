import { Controller, Post, Get, Body, HttpCode, Req } from '@nestjs/common'
import { ApiTags, ApiOperation, ApiBody, ApiOkResponse } from '@nestjs/swagger'
import { IAgentChatGateway } from './domain'
import { SendMessageDto, AgentHealthDto } from './dtos'
import { FlatResponse } from '#core'

@ApiTags('agent-chat')
@Controller('api/agent')
export class AgentChatController {
  constructor(private readonly hub: IAgentChatGateway) {}

  @ApiOperation({ description: 'Send a message to the agent (HTTP fallback)', operationId: 'sendAgentMessage' })
  @ApiBody({ type: SendMessageDto })
  @FlatResponse()
  @Post('message')
  @HttpCode(200)
  async sendMessage(@Req() req: any, @Body() body: SendMessageDto) {
    // Use authenticated user id or generate a transient clientId
    const clientId = req.user?.id ?? 'http-' + crypto.randomUUID()
    this.hub.sendToAgent(clientId, body.text, body.images)
    return { ok: true }
  }

  @ApiOperation({ description: 'Check agent connection status', operationId: 'agentHealth' })
  @FlatResponse()
  @ApiOkResponse({ type: AgentHealthDto })
  @Get('health')
  async health() {
    return this.hub.health()
  }
}
