import { describe, expect, test } from "bun:test"
import { ChannelService } from "./channel.service"
import type { IChannelGateway } from "./channel.gateway"
import type { IChannelGroup } from "./channel.types"

function gateway(
  name: string,
  listGroups?: () => Promise<IChannelGroup[]>,
): IChannelGateway {
  return {
    name,
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    send: () => Promise.resolve(),
    onMessage: () => {},
    ...(listGroups ? { listGroups } : {}),
  }
}

describe("ChannelService.start", () => {
  test("returns per-channel outcomes, isolating failures", async () => {
    const service = new ChannelService()
    service.add(gateway("telegram"))
    const broken = gateway("slack")
    broken.start = () => Promise.reject(new Error("401 invalid_auth"))
    service.add(broken)

    const results = await service.start()

    expect(results).toEqual([
      { name: "telegram", ok: true },
      { name: "slack", ok: false, error: "401 invalid_auth" },
    ])
  })
})

describe("ChannelService.listGroups", () => {
  test("aggregates groups per channel, skipping channels without the concept", async () => {
    const service = new ChannelService()
    const tgGroups: IChannelGroup[] = [
      { id: "-100", name: "News", type: "supergroup", status: "member" },
    ]
    service.add(gateway("telegram", () => Promise.resolve(tgGroups)))
    service.add(gateway("bridle")) // no listGroups → skipped

    const result = await service.listGroups()
    expect(result).toEqual([{ channel: "telegram", groups: tgGroups }])
  })

  test("filters by channel name", async () => {
    const service = new ChannelService()
    service.add(gateway("telegram", () => Promise.resolve([{ id: "-100" }])))
    service.add(gateway("slack", () => Promise.resolve([{ id: "C01" }])))

    const result = await service.listGroups("slack")
    expect(result).toEqual([{ channel: "slack", groups: [{ id: "C01" }] }])
  })

  test("a failing channel reports an error instead of hiding the rest", async () => {
    const service = new ChannelService()
    service.add(gateway("telegram", () => Promise.resolve([{ id: "-100" }])))
    service.add(gateway("slack", () => Promise.reject(new Error("api down"))))

    const result = await service.listGroups()
    expect(result).toEqual([
      { channel: "telegram", groups: [{ id: "-100" }] },
      { channel: "slack", groups: [], error: "api down" },
    ])
  })

  test("unknown channel filter → empty result", async () => {
    const service = new ChannelService()
    service.add(gateway("telegram", () => Promise.resolve([{ id: "-100" }])))
    expect(await service.listGroups("slack")).toEqual([])
  })
})
