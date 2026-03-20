export const NVIDIA = {
  host: 'integrate.api.nvidia.com',
  path: '/v1/chat/completions',
  key: process.env.NVIDIA_API_KEY ?? '',
  model: 'google/gemma-2-2b-it',
  temperature: 0.2,
  top_p: 0.7,
  max_tokens: 1024,
} as const

export const ANTHROPIC = {
  host: 'api.anthropic.com',
  path: '/v1/messages',
  key: process.env.ANTHROPIC_API_KEY ?? '',
  model: 'claude-sonnet-4-20250514',
  version: '2023-06-01',
  max_tokens: 1024,
} as const

const NO_TOOLS  = ["google/", "meta/", "mistralai/", "microsoft/phi"]
const NO_SYSTEM = ["google/gemma", "microsoft/phi"]

export const modelSupportsTools  = (m: string) => !NO_TOOLS.some(p => m.toLowerCase().startsWith(p))
export const modelSupportsSystem = (m: string) => !NO_SYSTEM.some(p => m.toLowerCase().startsWith(p))
