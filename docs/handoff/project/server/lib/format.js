export const formatTicketNo = (n) => `FD-${String(n).padStart(4, '0')}`;

// Dates leave the API as ISO-8601 UTC ("...Z"). null stays null.
export const iso = (value) => (value == null ? null : new Date(value).toISOString());
