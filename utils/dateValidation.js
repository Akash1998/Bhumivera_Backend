function validateDateRange(body, startField, endField, { required = false, minDurationMs = 0 } = {}) {
  const startValue = body?.[startField];
  const endValue = body?.[endField];
  const hasStart = startValue !== undefined && startValue !== null && startValue !== '';
  const hasEnd = endValue !== undefined && endValue !== null && endValue !== '';

  if ((!hasStart || !hasEnd) && (required || hasStart !== hasEnd)) {
    return { valid: false, field: !hasStart ? startField : endField, message: 'Both date values are required.' };
  }
  if (!hasStart && !hasEnd) return { valid: true, startDate: null, endDate: null };

  const startDate = new Date(startValue);
  const endDate = new Date(endValue);
  if (!Number.isFinite(startDate.getTime())) {
    return { valid: false, field: startField, message: `${startField} must be a valid date.` };
  }
  if (!Number.isFinite(endDate.getTime())) {
    return { valid: false, field: endField, message: `${endField} must be a valid date.` };
  }
  if (endDate.getTime() - startDate.getTime() < minDurationMs) {
    return { valid: false, field: endField, message: `The end date must be at least ${minDurationMs} milliseconds after the start date.` };
  }

  return { valid: true, startDate, endDate };
}

module.exports = { validateDateRange };