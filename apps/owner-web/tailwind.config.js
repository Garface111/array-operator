/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0f172a",
        muted: "#64748b",
        line: "rgba(33, 150, 243, 0.14)",
        sky: {
          50: "#f0f9ff",
          100: "#e0f2fe",
          500: "#2196f3",
          600: "#1e88e5",
          700: "#1976d2",
        },
        good: "#10b981",
        warn: "#f59e0b",
        bad: "#ef4444",
      },
      fontFamily: {
        sans: [
          "Plus Jakarta Sans",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif",
        ],
      },
      boxShadow: {
        card: "0 8px 24px -14px rgba(15, 50, 110, 0.28)",
        sheet: "0 20px 50px -20px rgba(15, 40, 80, 0.45)",
      },
      borderRadius: {
        sheet: "1.25rem",
      },
    },
  },
  plugins: [],
};
