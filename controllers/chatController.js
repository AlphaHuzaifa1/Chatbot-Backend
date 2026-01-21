import { createSession } from '../models/sessionModel.js';
import { getUserById } from '../models/userModel.js';

const ALLOW_GUEST_MODE = process.env.ALLOW_GUEST_CHAT === 'true' || process.env.NODE_ENV === 'development';

export const startChat = async (req, res) => {
  try {
    let customerContext = {};
    let userId = null;

    if (req.user) {
      const user = await getUserById(req.user.id);
      if (!user) {
        return res.status(401).json({
          success: false,
          error: 'User not found'
        });
      }

      userId = user.id;
      customerContext = {
        fullName: user.full_name || null,
        email: user.email || null,
        phone: user.phone || null,
        companyName: user.company || null,
        vsaAgentName: user.vsa_agent_name || null
      };
    } else {
      if (!ALLOW_GUEST_MODE) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required. Please log in to start a chat session.'
        });
      }

      const { fullName, email, phone, companyName, vsaAgentName } = req.body;

      if (!email) {
        return res.status(400).json({
          success: false,
          error: 'Email is required for guest mode'
        });
      }

      customerContext = {
        fullName: fullName || null,
        email: email.trim().toLowerCase(),
        phone: phone || null,
        companyName: companyName || null,
        vsaAgentName: vsaAgentName || null
      };
    }

    const session = await createSession(customerContext, userId);
    
    res.status(201).json({
      success: true,
      sessionId: session.session_id,
      status: session.status,
      intakeStatus: session.intake_status,
      createdAt: session.created_at
    });
  } catch (error) {
    console.error('Error starting chat session:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to start chat session',
      message: error.message
    });
  }
};

