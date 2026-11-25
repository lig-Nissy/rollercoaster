import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: 32,
          height: 32,
          background: "#0f172a",
          borderRadius: 6,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          {/* Track */}
          <path
            d="M2 18 Q6 6 10 10 Q14 14 18 6 L22 8"
            stroke="#f59e0b"
            strokeWidth="2"
            strokeLinecap="round"
            fill="none"
          />
          {/* Cart */}
          <rect x="9" y="8" width="6" height="4" rx="1" fill="#ef4444" />
          <circle cx="10.5" cy="13" r="1" fill="#94a3b8" />
          <circle cx="13.5" cy="13" r="1" fill="#94a3b8" />
        </svg>
      </div>
    ),
    { ...size }
  );
}
