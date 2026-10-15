const RATES = {
  A: { base: 4.2, perKg: 0.85, surcharge: 0 },
  B: { base: 5.1, perKg: 1.15, surcharge: 0 },
  C: { base: 7.75, perKg: 1.6, surcharge: 2.5 },
};
const MAX_KG = 30;

/**
 * Price in USD of shipping one parcel of `kg` kilograms to `zone` ("A", "B" or "C"), from
 * Parcelwing's current rate card. Throws a RangeError for an unknown zone or a parcel the
 * carrier won't accept.
 */
export function shippingCost(zone, kg) {
  const rate = RATES[zone];
  if (!rate) throw new RangeError(`unknown zone ${zone}`);
  if (!(kg > 0) || kg > MAX_KG) throw new RangeError(`weight ${kg} kg not accepted`);
  const billable = Math.max(1, Math.ceil(kg));
  return Math.round((rate.base + rate.perKg * billable + rate.surcharge) * 100) / 100;
}
