/* ---------- Formatting & date helpers ---------- */
export function fmtINR(n) {
  n = Number(n) || 0;
  const neg = n < 0;
  const v = Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (neg ? '-' : '') + '₹' + v;
}

export function fmtINRShort(n) {
  n = Number(n) || 0;
  const neg = n < 0;
  const abs = Math.abs(n);
  let val, suffix;
  if (abs >= 1e7) { val = abs / 1e7; suffix = 'Cr'; }
  else if (abs >= 1e5) { val = abs / 1e5; suffix = 'L'; }
  else if (abs >= 1e3) { val = abs / 1e3; suffix = 'K'; }
  else { val = abs; suffix = ''; }
  const str = suffix ? val.toFixed(1).replace(/\.0$/, '') : Math.round(val).toString();
  return (neg ? '-' : '') + '₹' + str + suffix;
}

export function todayStr() { return new Date().toISOString().slice(0, 10); }

export function currentMonthKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

export function monthKeyLabel(key) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

export function monthKeyShort(key) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
}

export function addMonths(key, n) {
  let [y, m] = key.split('-').map(Number);
  m += n;
  while (m > 12) { m -= 12; y += 1; }
  while (m < 1) { m += 12; y -= 1; }
  return y + '-' + String(m).padStart(2, '0');
}

export function diffMonths(fromKey, toKey) {
  const [fy, fm] = fromKey.split('-').map(Number);
  const [ty, tm] = toKey.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

export function ordinalSuffix(n) {
  n = Number(n);
  if (n >= 11 && n <= 13) return 'th';
  switch (n % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}
