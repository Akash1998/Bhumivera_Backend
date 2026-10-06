const CAMEL_TO_SNAKE = {
  fullName: 'full_name',
  phoneNumber: 'phone_number',
  address1: 'street_address',
  line1: 'street_address',
  address2: 'line2',
  line2: 'line2',
  postalCode: 'postal_code',
  zipCode: 'postal_code',
  zip: 'postal_code',
  pincode: 'postal_code',
  isDefault: 'is_default',
  securityQuestion: 'security_question',
  securityAnswer: 'security_answer_hash',
  dateOfBirth: 'date_of_birth'
};

const SNAKE_ALIASES = {
  full_name: 'full_name',
  phone: 'phone',
  phone_number: 'phone_number',
  street_address: 'street_address',
  line1: 'street_address',
  line2: 'line2',
  address1: 'street_address',
  address2: 'line2',
  postal_code: 'postal_code',
  zip: 'postal_code',
  pincode: 'postal_code',
  city: 'city',
  state: 'state',
  country: 'country',
  label: 'label',
  is_default: 'is_default'
};

const PRIMARY_KEYS = [
  'full_name', 'phone', 'phone_number', 'street_address',
  'line2', 'postal_code', 'city', 'state', 'country',
  'label', 'is_default'
];

function pickFirstValue(obj, candidates) {
  for (const k of candidates) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') {
      return obj[k];
    }
  }
  return undefined;
}

function normalizeAddressKeys(input = {}) {
  const src = (typeof input === 'object' && input !== null) ? input : {};
  const out = { ...input };

  const full_name = pickFirstValue(src, ['full_name', 'fullName', 'name']);
  if (full_name !== undefined) {
    out.full_name = full_name;
  }

  const phone = pickFirstValue(src, ['phone', 'phone_number', 'phoneNumber', 'mobile', 'contact']);
  if (phone !== undefined) {
    out.phone = phone;
    out.phone_number = phone;
  }

  const street_address = pickFirstValue(src, ['street_address', 'line1', 'address1', 'address', 'street']);
  if (street_address !== undefined) {
    out.street_address = street_address;
    out.line1 = street_address;
  }

  const line2 = pickFirstValue(src, ['line2', 'address2']);
  if (line2 !== undefined) {
    out.line2 = line2;
  }

  const postal_code = pickFirstValue(src, ['postal_code', 'pincode', 'zip', 'zipCode', 'postalCode']);
  if (postal_code !== undefined) {
    out.postal_code = postal_code;
    out.pincode = postal_code;
  }

  for (const k of ['city', 'state', 'country', 'label']) {
    if (src[k] !== undefined && src[k] !== null) {
      out[k] = src[k];
    }
  }

  if (src.is_default !== undefined) {
    out.is_default = src.is_default ? 1 : 0;
  } else if (src.isDefault !== undefined) {
    out.is_default = src.isDefault ? 1 : 0;
  }

  const result = {};
  for (const key of Object.keys(out)) {
    const val = out[key];
    if (val !== undefined && val !== null) {
      result[key] = val;
    }
  }
  return result;
}

const _idempotencyCheck = (obj) => {
  const once = normalizeAddressKeys(obj);
  const twice = normalizeAddressKeys(once);
  return JSON.stringify(once) === JSON.stringify(twice);
};

module.exports = {
  normalizeAddressKeys,
  CAMEL_TO_SNAKE,
  _addressPrimaryKeys: PRIMARY_KEYS
};
