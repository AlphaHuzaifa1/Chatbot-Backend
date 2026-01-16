export const testController = async (req, res) => {
  try {
    res.status(200).json({
      message: 'API running',
      timestamp: new Date().toISOString(),
      status: 'success'
    });
  } catch (error) {
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

