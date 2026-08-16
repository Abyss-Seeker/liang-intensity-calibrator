import {
  DEFAULT_HALF_LIFE_HOURS,
  halfLifeMsFromHours,
  tallyFromEvents,
} from "./progression";
import type { VoteTally } from "./vote";

export interface DisplayTally {
  up: number;
  down: number;
  weightedUp: number;
  weightedDown: number;
  level: number;
  approximate: boolean;
}

export function resolveDisplayTally(
  server: VoteTally,
  halfLifeHours: number,
  now: number,
): DisplayTally {
  if (halfLifeHours === DEFAULT_HALF_LIFE_HOURS) {
    return {
      up: server.up,
      down: server.down,
      weightedUp: server.weightedUp,
      weightedDown: server.weightedDown,
      level: server.level,
      approximate: false,
    };
  }

  const local = tallyFromEvents(
    server.events,
    halfLifeMsFromHours(halfLifeHours),
    now,
  );
  return {
    // 原始 30 天票数不受半衰期设置影响，始终采用服务端完整聚合。
    up: server.up,
    down: server.down,
    weightedUp: local.weightedUp,
    weightedDown: local.weightedDown,
    level: local.level,
    approximate: Boolean(server.eventsTruncated),
  };
}
