# TRACEABILITY — CHG-005

| PRD ID | 实现文件 | 验证 |
|--------|---------|------|
| R30 | src/index.ts (after_provider_response + tool_result 当场重试) | test/fallback-retry.test.ts: 401/403/quota 当场标 unavailable 并重试 |
| R31 | 同上 rank 逐个试 | 同上：候选耗尽前持续重试 |
| R32 | 防循环 Map | 同上：同 prompt 限 N 次 |
| R33 | 每 session 独立 | probe snapshot per session |
| R34 | 全量单测 | `npm test` 全绿 |

```bash
npm test                # 含 fallback-retry
npm run typecheck
pi update --extensions
```