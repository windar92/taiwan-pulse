// Vercel serverless function：/api/profile
// 邏輯共用 lib/intel.js，與本地 server.js 同源，避免分歧。
import { handleProfile } from "../lib/intel.js";

export const config = { maxDuration: 30 };

export default function handler(req, res) {
  return handleProfile(req, res);
}
