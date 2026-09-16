const getHealthStatus = (req, res) => {
  res.status(200).json({
    success: true,
    message: 'FindLocal API is running healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
};

module.exports = {
  getHealthStatus,
};
