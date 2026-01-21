import { registerUser, authenticateUser, generateToken } from '../services/authService.js';

export const signup = async (req, res) => {
  try {
    const { email, password, fullName, phone, company, vsaAgentName } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required'
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        error: 'Password must be at least 6 characters long'
      });
    }

    const user = await registerUser({ 
      email, 
      password, 
      fullName, 
      phone, 
      company, 
      vsaAgentName 
    });

    const token = generateToken({
      userId: user.id,
      email: user.email,
      role: user.role
    });

    res.status(201).json({
      success: true,
      message: 'User created successfully',
      token,
      user: {
        id: user.id,
        fullName: user.full_name,
        email: user.email,
        phone: user.phone,
        company: user.company,
        vsaAgentName: user.vsa_agent_name,
        role: user.role,
        status: user.status
      }
    });
  } catch (error) {
    console.error('Signup error:', error);
    
    if (error.message === 'User with this email already exists') {
      return res.status(409).json({
        success: false,
        error: error.message
      });
    }

    res.status(500).json({
      success: false,
      error: 'Failed to create user',
      message: error.message
    });
  }
};

export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required'
      });
    }

    const user = await authenticateUser(email, password);

    const token = generateToken({
      userId: user.id,
      email: user.email,
      role: user.role
    });

    res.status(200).json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        fullName: user.full_name,
        email: user.email,
        role: user.role,
        status: user.status
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    
    if (error.message === 'Invalid email or password' || error.message === 'Account is not active') {
      const statusCode = error.message === 'Account is not active' ? 403 : 401;
      return res.status(statusCode).json({
        success: false,
        error: error.message
      });
    }

    res.status(500).json({
      success: false,
      error: 'Failed to login',
      message: error.message
    });
  }
};

