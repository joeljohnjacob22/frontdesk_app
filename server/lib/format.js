export function formatTicketNo(number) {
  return `FD-${String(number).padStart(4, '0')}`;
}

export function iso(date) {
  return date == null ? null : new Date(date).toISOString();
}
