/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0E1420",
        muted: "#4C596B",
        faint: "#6B7789",
        line: "rgba(20, 60, 120, 0.16)",
        sky: {
          50: "#EAF4FD",
          100: "#D9E7FB",
          200: "#BEE3FA",
          400: "#56B4F0",
          500: "#2196F3",
          600: "#1E88E5",
          700: "#1976D2",
          800: "#1565C0",
        },
        live: "#22C55E",
        good: "#2196F3",
        warn: "#F59E0B",
        bad: "#EF4444",
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
        card: "0 8px 30px rgba(20, 60, 120, 0.1)",
        sheet: "0 18px 50px -12px rgba(20, 60, 120, 0.18)",
      },
      borderRadius: {
        sheet: "1.75rem",
      },
    },
  },
  plugins: [],
};
