const sendOTP = async (phone, otp) => {
  try {
    console.log(`\n\n=== FREE OTP INTERCEPT ===\nTARGET PHONE: ${phone}\nAUTHORIZATION CODE: ${otp}\n==========================\n\n`);
    return { success: true, message: "OTP logged to server console" };
  } catch (error) {
    throw new Error('Failed to process OTP');
  }
};

module.exports = { sendOTP };
