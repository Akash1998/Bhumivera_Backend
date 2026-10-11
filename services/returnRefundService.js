const MIN_REFUND_PAISE = 100;
const REFUND_PAGE_SIZE = 100;
const MAX_REFUND_HISTORY = 1000;
const ACTIVE_REFUND_STATES = new Set(['requesting', 'pending', 'processed', 'unknown']);

const toPaise = value => {
  const amount = String(value ?? '');
  const match = amount.match(/^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const paise = BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0') || '0');
  return paise <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(paise) : null;
};

const fetchRefundHistory = async (razorpay, paymentId) => {
  const refunds = [];
  for (let skip = 0; skip < MAX_REFUND_HISTORY; skip += REFUND_PAGE_SIZE) {
    const response = await razorpay.payments.fetchMultipleRefund(paymentId, {
      count: REFUND_PAGE_SIZE,
      skip,
    });
    const page = Array.isArray(response?.items) ? response.items : null;
    if (!page) throw new Error('Razorpay returned an invalid refund history.');
    refunds.push(...page);
    if (page.length < REFUND_PAGE_SIZE) return refunds;
  }
  throw Object.assign(new Error('Refund history exceeds the supported reconciliation limit.'), {
    code: 'REFUND_HISTORY_LIMIT',
    statusCode: 503,
  });
};

const reconcileReturnRefund = async ({ pool, razorpay, returnId }) => {
  if (!Number.isSafeInteger(returnId) || returnId < 1) {
    throw refundError(400, 'INVALID_RETURN_ID', 'Choose a valid return request.');
  }
  const [[request]] = await pool.query(
    `SELECT id, receipt, payment_id, provider_refund_id, amount_paise, status
     FROM return_refund_requests
     WHERE return_id = ? ORDER BY attempt_no DESC LIMIT 1`,
    [returnId]
  );
  if (!request) throw refundError(404, 'REFUND_REQUEST_NOT_FOUND', 'No provider refund request exists for this return.');
  if (['processed', 'failed'].includes(request.status)) {
    return {
      receipt: request.receipt,
      providerRefundId: request.provider_refund_id,
      amountPaise: Number(request.amount_paise),
      status: request.status,
      returnStatus: request.status === 'processed' ? 'refunded' : 'received',
    };
  }

  let providerRefunds;
  try {
    providerRefunds = await fetchRefundHistory(razorpay, request.payment_id);
  } catch (error) {
    if (error.code === 'REFUND_HISTORY_LIMIT') throw error;
    throw refundError(503, 'REFUND_PROVIDER_CHECK_FAILED',
      'Could not retrieve refund status from Razorpay. No new refund was submitted.');
  }
  const providerRefund = providerRefunds.find(refund =>
    (request.provider_refund_id && refund.id === request.provider_refund_id) ||
    refund.receipt === request.receipt
  );
  if (!providerRefund) {
    throw refundError(409, 'REFUND_NOT_FOUND_AT_PROVIDER',
      'Razorpay has not confirmed this refund receipt yet. No retry was submitted.',
      { receipt: request.receipt });
  }
  if (
    !providerRefund.id ||
    providerRefund.payment_id !== request.payment_id ||
    providerRefund.amount !== Number(request.amount_paise) ||
    !['pending', 'processed', 'failed'].includes(providerRefund.status)
  ) {
    throw refundError(409, 'REFUND_PROVIDER_DETAILS_MISMATCH',
      'Razorpay refund details do not match the saved request. Manual review is required.',
      { receipt: request.receipt });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[locked]] = await connection.query(
      `SELECT id, return_id, receipt, payment_id, amount_paise, status
       FROM return_refund_requests WHERE id = ? FOR UPDATE`,
      [request.id]
    );
    if (!locked || locked.receipt !== request.receipt ||
        locked.payment_id !== providerRefund.payment_id ||
        Number(locked.amount_paise) !== providerRefund.amount) {
      throw refundError(409, 'REFUND_REQUEST_CHANGED',
        'The saved refund request changed. Reload before reconciling.');
    }
    const status = providerRefund.status;
    await connection.query(
      `UPDATE return_refund_requests
       SET provider_refund_id = COALESCE(provider_refund_id, ?), status = ?,
           failure_code = CASE WHEN ? = 'failed' THEN 'PROVIDER_REFUND_FAILED' ELSE NULL END
       WHERE id = ?`,
      [providerRefund.id, status, status, request.id]
    );
    const returnStatus = status === 'processed'
      ? 'refunded'
      : status === 'failed'
        ? 'received'
        : 'refund_pending';
    await connection.query(
      `UPDATE returns SET status = ?
       WHERE id = ? AND status IN ('received', 'refund_pending')`,
      [returnStatus, returnId]
    );
    await connection.commit();
    return {
      receipt: request.receipt,
      providerRefundId: providerRefund.id,
      amountPaise: Number(request.amount_paise),
      status,
      returnStatus,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

const refundError = (statusCode, code, message, details = {}) =>
  Object.assign(new Error(message), { statusCode, code, ...details });

const createReturnRefund = async ({
  pool,
  razorpay,
  returnId,
  amountPaise,
  admin,
  adminNotes,
}) => {
  if (!Number.isSafeInteger(returnId) || returnId < 1) {
    throw refundError(400, 'INVALID_RETURN_ID', 'Choose a valid return request.');
  }
  if (!Number.isSafeInteger(amountPaise) || amountPaise < MIN_REFUND_PAISE) {
    throw refundError(400, 'INVALID_REFUND_AMOUNT', 'Refund amount must be at least ₹1.00.');
  }
  if (!razorpay?.payments?.fetch || !razorpay?.payments?.fetchMultipleRefund || !razorpay?.payments?.refund) {
    throw refundError(503, 'RAZORPAY_NOT_CONFIGURED', 'Razorpay refund methods are not available.');
  }

  const [[initial]] = await pool.query(
    `SELECT r.id, r.order_id, r.refund_type, r.status, o.payment_id, o.payment_mode,
            o.payment_status, o.total
     FROM returns r JOIN orders o ON o.id = r.order_id
     WHERE r.id = ?`,
    [returnId]
  );
  if (!initial) throw refundError(404, 'RETURN_NOT_FOUND', 'Return request not found.');
  if (initial.status !== 'received') {
    throw refundError(409, 'RETURN_NOT_READY_FOR_REFUND', 'The returned item must be marked received before a refund can be issued.');
  }
  if (initial.refund_type !== 'refund') {
    throw refundError(409, 'RETURN_IS_NOT_REFUNDABLE', 'This return request is not configured for a monetary refund.');
  }
  if (initial.payment_mode !== 'online' || initial.payment_status !== 'paid' || !initial.payment_id) {
    throw refundError(409, 'CAPTURED_PAYMENT_REQUIRED', 'A captured online payment is required for an automated refund.');
  }

  const orderTotalPaise = toPaise(initial.total);
  if (!orderTotalPaise) {
    throw refundError(409, 'INVALID_ORDER_TOTAL', 'The stored order total cannot be reconciled safely.');
  }

  let payment;
  let providerRefunds;
  try {
    payment = await razorpay.payments.fetch(initial.payment_id);
    providerRefunds = await fetchRefundHistory(razorpay, initial.payment_id);
  } catch (error) {
    if (error.code === 'REFUND_HISTORY_LIMIT') throw error;
    throw refundError(503, 'REFUND_PROVIDER_CHECK_FAILED',
      'Could not verify the payment and its existing refunds with Razorpay. No refund was requested.');
  }
  if (
    payment?.id !== initial.payment_id ||
    payment.status !== 'captured' ||
    payment.currency !== 'INR' ||
    payment.amount !== orderTotalPaise ||
    !Number.isSafeInteger(payment.amount_refunded || 0) ||
    (payment.amount_refunded || 0) < 0 ||
    (payment.amount_refunded || 0) > payment.amount
  ) {
    throw refundError(409, 'PAYMENT_NOT_REFUNDABLE', 'Razorpay payment details do not match the paid order.');
  }

  const providerRefundIds = new Set(providerRefunds.map(refund => refund.id).filter(Boolean));
  if (providerRefunds.some(refund =>
    !refund.id || !Number.isSafeInteger(refund.amount) || refund.amount < 1 ||
    !['pending', 'processed', 'failed'].includes(refund.status)
  )) {
    throw refundError(503, 'REFUND_HISTORY_INVALID',
      'Razorpay returned invalid refund history. No refund was requested.');
  }
  const providerActiveRefunds = providerRefunds.reduce((total, refund) => (
    ['pending', 'processed'].includes(refund.status) && Number.isSafeInteger(refund.amount)
      ? total + refund.amount
      : total
  ), 0);
  const providerCommittedPaise = Math.max(payment.amount_refunded || 0, providerActiveRefunds);

  const connection = await pool.getConnection();
  let reservation;
  try {
    await connection.beginTransaction();
    const [[locked]] = await connection.query(
      `SELECT r.id, r.order_id, r.refund_type, r.status, o.payment_id, o.payment_mode,
              o.payment_status, o.total
       FROM returns r JOIN orders o ON o.id = r.order_id
       WHERE r.id = ? FOR UPDATE`,
      [returnId]
    );
    if (!locked || locked.order_id !== initial.order_id || locked.payment_id !== initial.payment_id) {
      throw refundError(409, 'RETURN_CHANGED', 'Return payment details changed. Reload before retrying.');
    }
    if (locked.status !== 'received' || locked.refund_type !== 'refund' ||
        locked.payment_mode !== 'online' || locked.payment_status !== 'paid') {
      throw refundError(409, 'RETURN_NOT_READY_FOR_REFUND', 'Return or payment status changed. Reload before retrying.');
    }

    const [existing] = await connection.query(
      `SELECT return_id, receipt, amount_paise, status, provider_refund_id
       FROM return_refund_requests
       WHERE order_id = ? AND status IN ('requesting', 'pending', 'processed', 'unknown')
       FOR UPDATE`,
      [locked.order_id]
    );
    if (existing.some(item => Number(item.return_id) === returnId)) {
      throw refundError(409, 'REFUND_ALREADY_REQUESTED',
        'This return already has a refund request in progress or completed.');
    }
    const localReservations = existing.reduce((total, item) => (
      ACTIVE_REFUND_STATES.has(item.status) &&
      item.status !== 'processed' &&
      ((!item.provider_refund_id || !providerRefundIds.has(item.provider_refund_id)) &&
        !providerRefunds.some(refund => refund.receipt === item.receipt))
        ? total + Number(item.amount_paise)
        : total
    ), 0);
    const remainingPaise = orderTotalPaise - providerCommittedPaise - localReservations;
    if (remainingPaise < MIN_REFUND_PAISE || amountPaise > remainingPaise) {
      throw refundError(409, 'REFUND_EXCEEDS_REMAINING_BALANCE',
        'The requested refund exceeds the payment’s remaining refundable balance.', {
          remainingPaise: Math.max(0, remainingPaise),
        });
    }

    const [[attempt]] = await connection.query(
      'SELECT COALESCE(MAX(attempt_no), 0) AS last_attempt FROM return_refund_requests WHERE return_id = ?',
      [returnId]
    );
    const attemptNo = Number(attempt.last_attempt) + 1;
    const receipt = `bvrma-${returnId}-${attemptNo}`;
    const [inserted] = await connection.query(
      `INSERT INTO return_refund_requests
        (return_id, order_id, attempt_no, receipt, payment_id, amount_paise, status,
         requested_by_admin_id, requested_by_email, admin_notes)
       VALUES (?, ?, ?, ?, ?, ?, 'requesting', ?, ?, ?)`,
      [
        returnId,
        locked.order_id,
        attemptNo,
        receipt,
        locked.payment_id,
        amountPaise,
        admin?.id || null,
        admin?.email || null,
        adminNotes || null,
      ]
    );
    reservation = { id: inserted.insertId, receipt, paymentId: locked.payment_id };
    await connection.query(
      `UPDATE returns SET status = 'refund_pending', refund_amount = ?, admin_notes = COALESCE(?, admin_notes)
       WHERE id = ? AND status = 'received'`,
      [amountPaise / 100, adminNotes || null, returnId]
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  let providerRefund;
  try {
    providerRefund = await razorpay.payments.refund(reservation.paymentId, {
      amount: amountPaise,
      speed: 'normal',
      receipt: reservation.receipt,
      notes: { return_id: String(returnId), order_id: String(initial.order_id) },
    });
    if (
      !providerRefund?.id ||
      providerRefund.payment_id !== reservation.paymentId ||
      providerRefund.amount !== amountPaise ||
      !['pending', 'processed', 'failed'].includes(providerRefund.status)
    ) {
      throw new Error('Razorpay returned an invalid refund response.');
    }
  } catch (error) {
    const providerStatus = Number(error.statusCode || error.status);
    const definiteFailure = providerStatus >= 400 && providerStatus < 500 &&
      ![408, 409, 429].includes(providerStatus);
    const status = definiteFailure ? 'failed' : 'unknown';
    const failureCode = String(error.code || 'PROVIDER_RESPONSE_UNCONFIRMED').slice(0, 100);
    const failureConnection = await pool.getConnection();
    try {
      await failureConnection.beginTransaction();
      await failureConnection.query(
        `UPDATE return_refund_requests SET status = ?, failure_code = ?
         WHERE id = ? AND status = 'requesting'`,
        [status, failureCode, reservation.id]
      );
      if (status === 'failed') {
        await failureConnection.query(
          "UPDATE returns SET status = 'received' WHERE id = ? AND status = 'refund_pending'",
          [returnId]
        );
      }
      await failureConnection.commit();
    } catch {
      await failureConnection.rollback();
      throw refundError(503, 'REFUND_STATUS_UNKNOWN',
        'Razorpay did not confirm the refund result, and the result could not be saved. Check receipt ' + reservation.receipt + ' before retrying.',
        { receipt: reservation.receipt });
    } finally {
      failureConnection.release();
    }
    if (status === 'unknown') {
      throw refundError(503, 'REFUND_STATUS_UNKNOWN',
        'Razorpay did not confirm the refund result. Check the Razorpay dashboard using receipt ' + reservation.receipt + ' before retrying.',
        { receipt: reservation.receipt });
    }
    throw refundError(502, 'REFUND_PROVIDER_REJECTED',
      'Razorpay rejected the refund request. The return remains eligible for a corrected retry.',
      { providerCode: failureCode });
  }

  const requestStatus = providerRefund.status;
  const returnStatus = requestStatus === 'processed'
    ? 'refunded'
    : requestStatus === 'pending'
      ? 'refund_pending'
      : 'received';
  const resultConnection = await pool.getConnection();
  try {
    await resultConnection.beginTransaction();
    const [[current]] = await resultConnection.query(
      'SELECT status FROM return_refund_requests WHERE id = ? FOR UPDATE',
      [reservation.id]
    );
    if (current?.status === 'requesting') {
      await resultConnection.query(
        `UPDATE return_refund_requests SET provider_refund_id = ?, status = ?, failure_code = ?
         WHERE id = ?`,
        [providerRefund.id, requestStatus, requestStatus === 'failed' ? 'PROVIDER_REFUND_FAILED' : null, reservation.id]
      );
      await resultConnection.query(
        `UPDATE returns SET status = ?
         WHERE id = ? AND status = 'refund_pending'`,
        [returnStatus, returnId]
      );
    } else if (current) {
      await resultConnection.query(
        'UPDATE return_refund_requests SET provider_refund_id = COALESCE(provider_refund_id, ?) WHERE id = ?',
        [providerRefund.id, reservation.id]
      );
    } else {
      throw new Error('The refund reservation disappeared before the provider response was saved.');
    }
    await resultConnection.commit();
  } catch (error) {
    await resultConnection.rollback();
    throw refundError(503, 'REFUND_RESULT_SAVE_FAILED',
      'Razorpay may have accepted the refund, but its result could not be saved. Check receipt ' + reservation.receipt + ' before retrying.',
      { receipt: reservation.receipt });
  } finally {
    resultConnection.release();
  }

  const [[savedRequest]] = await pool.query(
    'SELECT status FROM return_refund_requests WHERE id = ?',
    [reservation.id]
  );
  const actualStatus = savedRequest?.status || requestStatus;
  return {
    receipt: reservation.receipt,
    providerRefundId: providerRefund.id,
    amountPaise,
    status: actualStatus,
    returnStatus: actualStatus === 'processed'
      ? 'refunded'
      : actualStatus === 'pending'
        ? 'refund_pending'
        : 'received',
  };
};

module.exports = { createReturnRefund, reconcileReturnRefund, toPaise };
