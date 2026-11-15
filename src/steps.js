// The service checklist. Mirrors FCF's current Whip Around "Grease Trap Pump out/Clean" form,
// but every photo is tied to a specific facility record instead of a free-text location.
export const STEPS = [
  { key: 'before_closed', label: 'Trap before service (lid closed)', hint: 'Wide shot: lid + surrounding area', required: true },
  { key: 'under_lid', label: 'Lid removed: gaskets & lid condition', hint: 'Underside of lid and gasket', required: true },
  { key: 'full_before', label: 'Full trap before pumping', hint: 'Show the FOG layer before you pump', required: true },
  { key: 'after_clean', label: 'Trap after pumped & cleaned', hint: 'Baffles and walls visible', required: true },
  { key: 'damage', label: 'Damage to trap or internals', hint: 'Required if condition is not "Good"', required: false },
  { key: 'closed_after', label: 'Lid closed & area clean', hint: 'Same angle as the first photo', required: true },
  { key: 'door_locked', label: 'Exit door locked', hint: 'Required for after-hours / unattended service', required: false },
];
export const STEP_BY_KEY = Object.fromEntries(STEPS.map((s) => [s.key, s]));
export const CONDITIONS = { good: 'Good', minor: 'Minor issue', deficient: 'Deficient (needs repair)' };
