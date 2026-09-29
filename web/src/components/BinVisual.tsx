import clsx from "clsx";
import { motion } from "framer-motion";
import { useTween } from "./ui";

/**
 * A quiet, technical drawing of the smart bin. Everything moves with real
 * telemetry: the waste level, the lid (servo + lid sensor), the IR beam at the
 * mouth, and the RFID reader on the front panel.
 */
export function BinVisual({
  fill,
  lid,
  servo,
  ir,
  rfid = "idle",
  threshold = 85,
  monitor = 70,
  online = true,
  size = 180,
  className,
}: {
  fill: number;
  lid: string;
  servo: string;
  ir?: string;
  rfid?: string;
  threshold?: number;
  monitor?: number;
  online?: boolean;
  size?: number;
  className?: string;
}) {
  const f = Math.max(0, Math.min(100, fill));
  const full = f >= threshold;
  const watch = f >= monitor && !full;
  const open = lid === "open";
  const waste = !online ? "#d6d4cd" : full ? "#d9776f" : watch ? "#e3b25a" : "#a9b3a7";
  const wasteDeep = !online ? "#c8c6bf" : full ? "#c9564d" : watch ? "#d29a35" : "#8f9b8d";

  // Body interior spans y = 58..214 (height 156) inside a 200 x 240 viewBox.
  const top = 58;
  const h = 156;
  const shown = useTween(f, { duration: 0.9 });
  const levelY = top + h * (1 - shown / 100);
  const angle = useTween(open ? -58 : 0, { spring: { stiffness: 120, damping: 15 } });

  return (
    <div className={clsx("relative inline-block", className)} style={{ width: size, height: size * 1.2 }}>
      <svg viewBox="0 0 200 240" width={size} height={size * 1.2} role="img" aria-label={`Bin ${Math.round(f)}% full, lid ${lid}`}>
        <defs>
          <clipPath id="bin-inside">
            <path d="M40 58 H160 L152 210 Q151.5 216 145.5 216 H54.5 Q48.5 216 48 210 Z" />
          </clipPath>
          <pattern id="waste-lines" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="8" stroke={wasteDeep} strokeWidth="1.2" strokeOpacity="0.35" />
          </pattern>
        </defs>

        {/* ground shadow */}
        <ellipse cx="100" cy="229" rx="62" ry="5" fill="#17181b" opacity="0.06" />

        {/* full: a calm halo, not an alarm */}
        {full && online && (
          <motion.rect
            x="30"
            y="44"
            width="140"
            height="182"
            rx="16"
            fill="none"
            stroke="#cc4a40"
            strokeWidth="2"
            initial={{ opacity: 0.1 }}
            animate={{ opacity: [0.1, 0.45, 0.1] }}
            transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
          />
        )}

        {/* body */}
        <path d="M40 58 H160 L152 210 Q151.5 216 145.5 216 H54.5 Q48.5 216 48 210 Z" fill="#fcfcfb" stroke="#8a8883" strokeWidth="1.6" strokeLinejoin="round" />

        {/* waste */}
        <g clipPath="url(#bin-inside)">
          <rect x="36" y={levelY} width="128" height={Math.max(0, 220 - levelY)} fill={waste} fillOpacity={0.55} />
          <rect x="36" y={levelY} width="128" height={Math.max(0, 220 - levelY)} fill="url(#waste-lines)" />
          <line x1="36" x2="164" y1={levelY} y2={levelY} stroke={wasteDeep} strokeWidth="1.5" />
        </g>

        {/* threshold tick on the side */}
        <line x1="163" x2="170" y1={top + h * (1 - threshold / 100)} y2={top + h * (1 - threshold / 100)} stroke="#8a8883" strokeWidth="1" />
        <text x="172" y={top + h * (1 - threshold / 100) + 3} fontSize="8" fill="#8a8883" fontFamily="Inter Variable, sans-serif">
          {threshold}%
        </text>

        {/* vertical ribs */}
        <path d="M70 72 L72 200 M100 72 L100 200 M130 72 L128 200" stroke="#e6e4de" strokeWidth="1" />

        {/* IR beam across the mouth */}
        <motion.line
          x1="44"
          x2="156"
          y1="66"
          y2="66"
          stroke="#2a78d6"
          strokeWidth="1.2"
          initial={false}
          animate={{ opacity: ir === "triggered" ? [0.9, 0.15] : 0.12 }}
          transition={{ duration: 0.8 }}
        />

        {/* front panel: RFID reader + servo lock */}
        <rect x="80" y="150" width="40" height="30" rx="5" fill="#ffffff" stroke="#c3c2b7" strokeWidth="1" />
        <g transform="translate(92 158)">
          {[4, 7.5, 11].map((r, i) => (
            <path
              key={r}
              d={`M 0 ${7 - r} A ${r} ${r} 0 0 1 0 ${7 + r}`}
              fill="none"
              stroke={rfid === "verified" ? "#3e9a62" : rfid === "mismatch" || rfid === "invalid" || rfid === "unassigned" ? "#cc4a40" : "#b4b2ac"}
              strokeWidth="1.3"
              strokeLinecap="round"
              opacity={rfid === "idle" ? 0.9 - i * 0.2 : 1}
            />
          ))}
        </g>
        <g transform="translate(110 160)">
          <rect x="0" y="4" width="8" height="7" rx="1.5" fill={servo === "unlocked" ? "#3e9a62" : "#8a8883"} />
          <path d={servo === "unlocked" ? "M1.5 4 V2 A2.5 2.5 0 0 1 6.5 1.4" : "M1.5 4 V2 A2.5 2.5 0 0 1 6.5 2 V4"} fill="none" stroke={servo === "unlocked" ? "#3e9a62" : "#8a8883"} strokeWidth="1.3" />
        </g>

        {/* wheels */}
        <circle cx="62" cy="219" r="7" fill="#fcfcfb" stroke="#8a8883" strokeWidth="1.5" />
        <circle cx="138" cy="219" r="7" fill="#fcfcfb" stroke="#8a8883" strokeWidth="1.5" />

        {/* lid (hinged at the back-left) */}
        <g transform={`rotate(${angle.toFixed(2)} 34 52)`}>
          <path d="M34 52 H166 Q170 52 169 56 L167 60 H33 L31 56 Q30 52 34 52 Z" fill="#fcfcfb" stroke="#8a8883" strokeWidth="1.6" strokeLinejoin="round" />
          <rect x="88" y="46" width="24" height="6" rx="3" fill="#fcfcfb" stroke="#8a8883" strokeWidth="1.4" />
          {/* ultrasonic pair under the lid */}
          <circle cx="92" cy="63" r="3" fill="#ffffff" stroke="#8a8883" strokeWidth="1" />
          <circle cx="108" cy="63" r="3" fill="#ffffff" stroke="#8a8883" strokeWidth="1" />
        </g>

        {!online && (
          <g>
            <rect x="66" y="112" width="68" height="20" rx="10" fill="#ffffff" stroke="#c3c2b7" />
            <text x="100" y="125.5" textAnchor="middle" fontSize="10" fill="#52514e" fontFamily="Inter Variable, sans-serif" fontWeight="600">
              OFFLINE
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}
