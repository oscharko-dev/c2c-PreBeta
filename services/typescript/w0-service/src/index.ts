export function runPayroll(baseSalary: number, employees: number, taxRate: number): number {
  const gross = baseSalary * employees;
  const tax = gross * taxRate;
  return Number((gross - tax).toFixed(2));
}

export function runStatus(ok: boolean): string {
  return ok ? 'OK' : 'ALERT';
}
