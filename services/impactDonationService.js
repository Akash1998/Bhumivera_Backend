const { sendMail } = require('../utils/mail');

const IMPACT_DONATION_PROJECTS = new Map([
  ['hungry-feeding', 'Warm Meal Annadaan & Hunger Relief Kitchen'],
  ['stray-animal-care', 'Stray Dog & Cat Rescue, Feeding & Winter Beds'],
  ['elderly-disabled-rations', 'Food & Ration Kits for Disabled & Elderly Citizens'],
  ['damodar-cleanup', 'Damodar Riverbank Native Vetiver Planting & Plastic Cleanup'],
  ['jute-sapling-nursery', 'Backyard Native Sapling Nursery in 100% Jute Bags'],
  ['village-pukur-revival', 'Rural Bengal Village Pukur (Pond) Desilting & Natural Reeds'],
  ['herbal-kitchen-gardens', 'Medicinal Tulsi, Kalmegh & Neem Home Kitchen Gardens'],
  ['mandi-vermicomposting', 'Town Sabzi Mandi Waste to Organic Vermicompost Initiative'],
  ['coal-belt-microgrove', 'Paschim Bardhaman Industrial Edge Native Micro-Grove'],
]);

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

const sendImpactCertificateForContribution = async (pool, contributionId) => {
  const [rows] = await pool.query(
    `SELECT ic.*, u.name AS customer_name, u.email AS customer_email
     FROM impact_contributions ic
     JOIN users u ON u.id = ic.user_id
     WHERE ic.id = ?`,
    [contributionId]
  );
  const contribution = rows[0];
  if (!contribution) throw new Error(`Impact contribution ${contributionId} was not found.`);
  if (contribution.certificate_sent_at) return true;

  const name = contribution.customer_name || 'Bhumivera patron';
  const projectTitle = IMPACT_DONATION_PROJECTS.get(contribution.project_key);
  const amount = `₹${Number(contribution.amount).toLocaleString('en-IN')}`;
  const dedication = contribution.dedication
    ? `<p style="font-style:italic;color:#8b5a2b">Dedication: “${escapeHtml(contribution.dedication)}”</p>`
    : '';
  try {
    await sendMail({
      to: contribution.customer_email,
      subject: '[Bhumivera] Your Grassroots Stewardship Certificate',
      html: `
        <div style="border:2px solid #d4af37;padding:32px;text-align:center;background:#102219;color:#fff">
          <p style="letter-spacing:3px;color:#fce096">BHUMIVERA GRASSROOTS STEWARDSHIP</p>
          <h1 style="font-family:Georgia,serif;color:#fce096">Certificate of Ecological Co-Sponsorship</h1>
          <p>This certificate recognizes <strong>${escapeHtml(name)}</strong> for co-sponsoring field materials for
            <strong>${escapeHtml(projectTitle)}</strong> with a verified payment of <strong>${amount}</strong>.</p>
          ${dedication}
          <p>Certificate ID: <strong>${escapeHtml(contribution.certificate_code)}</strong></p>
          <p style="font-size:12px;color:#cbd5e1">This is a voluntary grassroots co-sponsorship record, not an 80G tax-exempt donation receipt.</p>
        </div>`,
      text: [
        'BHUMIVERA GRASSROOTS STEWARDSHIP',
        'Certificate of Ecological Co-Sponsorship',
        `This certificate recognizes ${name} for co-sponsoring field materials for ${projectTitle} with a verified payment of ${amount}.`,
        contribution.dedication ? `Dedication: ${contribution.dedication}` : null,
        `Certificate ID: ${contribution.certificate_code}`,
        'This is a voluntary grassroots co-sponsorship record, not an 80G tax-exempt donation receipt.',
      ].filter(Boolean).join('\n\n'),
      timeoutMs: 15000,
    });
    await pool.query(
      'UPDATE impact_contributions SET certificate_sent_at = NOW() WHERE id = ? AND certificate_sent_at IS NULL',
      [contribution.id]
    );
    return true;
  } catch (error) {
    console.error('[IMPACT_CERTIFICATE_EMAIL_FAILED]', {
      contributionId: contribution.id,
      paymentId: contribution.payment_id,
      error: error.message,
    });
    return false;
  }
};

module.exports = { IMPACT_DONATION_PROJECTS, sendImpactCertificateForContribution };
