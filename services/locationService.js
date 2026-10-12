import axios from 'axios';

/**
 * Extract browser and device information from User-Agent string
 */
export const parseUserAgent = (userAgent) => {
  if (!userAgent) {
    return {
      browser: 'Unknown',
      device: 'Unknown',
      os: 'Unknown'
    };
  }

  // Detect Browser
  let browser = 'Unknown';
  if (userAgent.includes('Firefox')) browser = 'Firefox';
  else if (userAgent.includes('Chrome') && !userAgent.includes('Edg')) browser = 'Chrome';
  else if (userAgent.includes('Safari') && !userAgent.includes('Chrome')) browser = 'Safari';
  else if (userAgent.includes('Edg')) browser = 'Edge';
  else if (userAgent.includes('Opera') || userAgent.includes('OPR')) browser = 'Opera';
  else if (userAgent.includes('MSIE') || userAgent.includes('Trident')) browser = 'Internet Explorer';

  // Detect Device
  let device = 'Desktop';
  if (/Mobile|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent)) {
    if (/iPad|Tablet/i.test(userAgent)) {
      device = 'Tablet';
    } else {
      device = 'Mobile';
    }
  }

  // Detect OS
  let os = 'Unknown';
  if (userAgent.includes('Windows NT 10.0')) os = 'Windows 10';
  else if (userAgent.includes('Windows NT 6.3')) os = 'Windows 8.1';
  else if (userAgent.includes('Windows NT 6.2')) os = 'Windows 8';
  else if (userAgent.includes('Windows NT 6.1')) os = 'Windows 7';
  else if (userAgent.includes('Windows')) os = 'Windows';
  else if (userAgent.includes('Mac OS X')) os = 'macOS';
  else if (userAgent.includes('Android')) os = 'Android';
  else if (userAgent.includes('iPhone') || userAgent.includes('iPad')) os = 'iOS';
  else if (userAgent.includes('Linux')) os = 'Linux';

  return { browser, device, os };
};

/**
 * Get IP address from request
 */
export const getClientIp = (req) => {
  // Check various headers for the real IP address
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  
  return req.headers['x-real-ip'] || 
         req.connection?.remoteAddress || 
         req.socket?.remoteAddress ||
         req.ip ||
         'Unknown';
};

// In-memory cache for IP geolocations to ensure sub-millisecond lookups
const ipLocationCache = new Map();

/**
 * Get location data from IP address using free IP geolocation API
 * Using ip-api.com with in-memory caching and ultra-fast timeout (350ms)
 */
export const getLocationFromIp = async (ipAddress) => {
  try {
    // Skip for localhost/private IPs
    if (!ipAddress || 
        ipAddress === 'Unknown' || 
        ipAddress === '::1' || 
        ipAddress === '127.0.0.1' ||
        ipAddress.startsWith('192.168.') ||
        ipAddress.startsWith('10.') ||
        ipAddress.startsWith('172.')) {
      return {
        country: 'Local/Private Network',
        countryCode: 'XX',
        region: 'N/A',
        city: 'N/A',
        latitude: null,
        longitude: null,
        timezone: 'UTC',
        isp: 'Local Network'
      };
    }

    if (ipLocationCache.has(ipAddress)) {
      return ipLocationCache.get(ipAddress);
    }

    // Call free IP geolocation API with tight 350ms timeout so form submissions are never blocked
    const response = await axios.get(`http://ip-api.com/json/${ipAddress}`, {
      timeout: 350
    });

    if (response.data && response.data.status === 'success') {
      const loc = {
        country: response.data.country || 'Unknown',
        countryCode: response.data.countryCode || 'XX',
        region: response.data.regionName || 'Unknown',
        city: response.data.city || 'Unknown',
        latitude: response.data.lat || null,
        longitude: response.data.lon || null,
        timezone: response.data.timezone || 'UTC',
        isp: response.data.isp || 'Unknown'
      };
      if (ipLocationCache.size > 1000) ipLocationCache.clear();
      ipLocationCache.set(ipAddress, loc);
      return loc;
    }

    return null;
  } catch (error) {
    // Non-blocking, return null silently for super-fast response
    return null;
  }
};

/**
 * Collect all submission metadata
 */
export const collectSubmissionMetadata = async (req, { includeLocation = true } = {}) => {
  const ipAddress = getClientIp(req);
  const userAgent = req.headers['user-agent'] || '';
  const { browser, device, os } = parseUserAgent(userAgent);

  const location = includeLocation ? await getLocationFromIp(ipAddress) : null;

  return {
    ipAddress,
    userAgent,
    browser,
    device,
    os,
    location: includeLocation
      ? location || {
          country: 'Unknown',
          countryCode: 'XX',
          region: 'Unknown',
          city: 'Unknown',
          latitude: null,
          longitude: null,
          timezone: 'UTC',
          isp: 'Unknown'
        }
      : null,
    submittedAt: new Date()
  };
};