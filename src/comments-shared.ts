export const COMMENT_TTL = 72 * 60 * 60 * 1000;
export const COMMENT_COOLDOWN = 5 * 60 * 1000;
export const COMMENT_DAY = 24 * 60 * 60 * 1000;
export const COMMENT_MAX_LENGTH = 500;
export type CommentVote = "up" | "down" | null;
export type CommentSort = "hot" | "new";
export interface CommentItem {
  id: string;
  body: string;
  createdAt: number;
  expiresAt: number;
  up: number;
  down: number;
  score: number;
  myVote: CommentVote;
}
export interface CommentPage {
  comments: CommentItem[];
  hasMore: boolean;
  serverTime: number;
}
