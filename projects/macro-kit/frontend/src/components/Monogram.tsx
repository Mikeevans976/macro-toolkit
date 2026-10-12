// "MM" monogram: two monoline M strokes inside a hairline tile.

interface Props {
  size?: number
  framed?: boolean
}

export default function Monogram({ size = 30, framed = true }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      role="img"
      aria-label="MM"
      style={{ flexShrink: 0, display: 'block' }}
    >
      {framed && (
        <>
          <rect x="0.5" y="0.5" width="31" height="31" rx="6.5" fill="#0b0f14" />
          <rect x="0.5" y="0.5" width="31" height="31" rx="6.5" stroke="#86c0de" strokeOpacity="0.32" />
        </>
      )}
      <path
        d="M5.5 22V10l4.5 7 4.5-7v12M17.5 22V10l4.5 7 4.5-7v12"
        stroke="#86c0de"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
