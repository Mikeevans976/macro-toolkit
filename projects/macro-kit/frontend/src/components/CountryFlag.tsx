// Country flag as an inline SVG (country-flag-icons, 3:2). Emoji flags are
// not used: Windows has no flag emoji and renders them as letter pairs.
import {
  AU, BR, CA, CH, CL, CN, CO, CZ, EU, GB, HU, ID, IL, IN, JP, KR, MX, MY,
  NO, NZ, PE, PH, PL, RO, SE, TH, TR, TW, US, ZA,
} from 'country-flag-icons/react/3x2'
import type { CountryCode } from '../features/heatmap/regions'

const FLAGS: Record<CountryCode, typeof US> = {
  AU, BR, CA, CH, CL, CN, CO, CZ, EU, GB, HU, ID, IL, IN, JP, KR, MX, MY,
  NO, NZ, PE, PH, PL, RO, SE, TH, TR, TW, US, ZA,
}

interface Props {
  country: CountryCode
  height?: number
  title?: string
}

export default function CountryFlag({ country, height = 12, title }: Props) {
  const Svg = FLAGS[country]
  return (
    <Svg
      title={title ?? country}
      aria-hidden={title ? undefined : true}
      style={{
        height,
        width: height * 1.5,
        display: 'block',
        flexShrink: 0,
        borderRadius: 2,
        boxShadow: '0 0 0 1px rgba(200,220,240,0.14)',
      }}
    />
  )
}
