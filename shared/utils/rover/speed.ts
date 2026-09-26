/**
 * Perseverance's top speed, m/s: "just under 0.1 mph (152 meters per hour)" (NASA, rover
 * components). The physical cap, the "commanded" reference the instruments measure against.
 */
export const ROVER_MAX_SPEED_MPS = 0.042

/**
 * Perseverance's driving rate under AutoNav, m/s: "up to 393 feet (120 meters) per hour" (JPL,
 * 2021). The rover images and plans while it drives, so this is the rate it actually covers ground
 * at, and the simulated rover's flat-ground speed.
 */
export const AUTONAV_EFFECTIVE_MPS = 0.033
