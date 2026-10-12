import Otp from '../models/Otp.js';
import smsService from '../services/smsService.js';
import mailService from '../services/mailService.js';

/**
 * @desc    Send OTP to mobile number
 * @route   POST /api/otp/send
 * @access  Public
 */
export const sendOtp = async (req, res) => {
    try {
        const { mobile, email } = req.body;

        if (!mobile && !email) {
            return res.status(400).json({
                success: false,
                message: 'Mobile number or email is required'
            });
        }

        // Generate 6-digit OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        if (mobile) {
            // Check if there is an existing OTP for this mobile and remove it
            await Otp.deleteMany({ mobile });

            // Save new OTP to database
            const newOtp = new Otp({
                mobile,
                otp,
                expiresAt: new Date(Date.now() + 5 * 60 * 1000) // 5 minutes expiry
            });

            await newOtp.save();

            // Send OTP via SMS
            const smsResult = await smsService.sendOTP(mobile, otp);

            if (!smsResult.success) {
                return res.status(500).json({
                    success: false,
                    message: 'Failed to send OTP SMS',
                    error: smsResult.error
                });
            }
        } else if (email) {
            // Check if there is an existing OTP for this email and remove it
            await Otp.deleteMany({ email: email.toLowerCase() });

            // Save new OTP to database
            const newOtp = new Otp({
                email: email.toLowerCase(),
                otp,
                expiresAt: new Date(Date.now() + 5 * 60 * 1000) // 5 minutes expiry
            });

            await newOtp.save();

            // Send OTP via Email
            const mailResult = await mailService.sendOTP(email.toLowerCase(), otp);

            if (!mailResult.success) {
                return res.status(500).json({
                    success: false,
                    message: 'Failed to send OTP email',
                    error: mailResult.error
                });
            }
        }

        res.status(200).json({
            success: true,
            message: 'OTP sent successfully',
            data: {
                success: true,
                message: 'OTP sent successfully',
                otp: process.env.NODE_ENV === 'development' ? otp : undefined
            }
        });

    } catch (error) {
        console.error('Send OTP error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};

/**
 * @desc    Verify OTP
 * @route   POST /api/otp/verify
 * @access  Public
 */
export const verifyOtp = async (req, res) => {
    try {
        const { mobile, email, otp } = req.body;

        if ((!mobile && !email) || !otp) {
            return res.status(400).json({
                success: false,
                message: 'Mobile number/email and OTP are required'
            });
        }

        const query = mobile ? { mobile, otp } : { email: email.toLowerCase(), otp };
        const otpRecord = await Otp.findOne(query);

        if (!otpRecord) {
            return res.status(400).json({
                success: false,
                message: 'Invalid OTP'
            });
        }

        if (otpRecord.expiresAt < new Date()) {
            await Otp.deleteOne({ _id: otpRecord._id });
            return res.status(400).json({
                success: false,
                message: 'OTP has expired'
            });
        }

        // Mark as verified
        otpRecord.isVerified = true;
        await otpRecord.save();

        res.status(200).json({
            success: true,
            message: 'OTP verified successfully',
            data: {
                success: true,
                message: 'OTP verified successfully'
            }
        });

    } catch (error) {
        console.error('Verify OTP error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};
