import type { Config } from "tailwindcss"
const config: Config = {
  content: ["./app/**/*.{ts,tsx}","./lib/**/*.{ts,tsx}"],
  theme: { extend: {
    fontFamily: {
      display: ["Cormorant Garamond","Georgia","serif"],
      sans: ["DM Sans","system-ui","sans-serif"],
    },
  }},
  plugins: [],
}
export default config