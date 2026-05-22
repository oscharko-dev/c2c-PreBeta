import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: {
          0: "var(--bg-0)",
          1: "var(--bg-1)",
          2: "var(--bg-2)",
          3: "var(--bg-3)",
          4: "var(--bg-4)",
          hover: "var(--bg-hover)",
          active: "var(--bg-active)",
          "active-strong": "var(--bg-active-strong)",
        },
        line: {
          DEFAULT: "var(--line)",
          2: "var(--line-2)",
          3: "var(--line-3)",
        },
        text: {
          DEFAULT: "var(--text)",
          dim: "var(--text-dim)",
          faint: "var(--text-faint)",
          bright: "var(--text-bright)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          dim: "var(--accent-dim)",
          soft: "var(--accent-soft)",
        },
        success: {
          DEFAULT: "var(--success)",
          badge: "var(--success-badge)",
          soft: "var(--success-soft)",
        },
        warn: {
          DEFAULT: "var(--warn)",
          soft: "var(--warn-soft)",
        },
        error: {
          DEFAULT: "var(--error)",
          badge: "var(--error-badge)",
          soft: "var(--error-soft)",
        },
        teal: {
          DEFAULT: "var(--teal)",
          soft: "var(--teal-soft)",
        },
        violet: {
          DEFAULT: "var(--violet)",
          soft: "var(--violet-soft)",
        },
        orange: {
          DEFAULT: "var(--orange)",
          soft: "var(--orange-soft)",
        },
      },
      fontFamily: {
        ui: ["var(--font-ui)"],
        mono: ["var(--font-mono)"],
      },
      fontSize: {
        xs: ["11px", "1.4"],
        sm: ["12px", "1.4"],
        base: ["13px", "1.4"],
        lg: ["14px", "1.4"],
      },
    },
  },
  plugins: [],
};

export default config;
