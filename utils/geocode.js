import axios from 'axios';

/**
 * Reverse geocoding using Nominatim (OpenStreetMap)
 * @param {number} lat - Latitude
 * @param {number} lng - Longitude
 * @returns {Promise<string>} - Human-readable address
 */
export const reverseGeocode = async (lat, lng) => {
  if (!lat || !lng) return 'Unknown Location';

  try {
    // Nominatim usage rules: https://operations.osmfoundation.org/policies/nominatim/
    // - max 1 request/second
    // - valid User-Agent required
    const response = await axios.get(`https://nominatim.openstreetmap.org/reverse`, {
      params: {
        format: 'json',
        lat: lat,
        lon: lng,
        zoom: 18,
        addressdetails: 1
      },
      headers: {
        'User-Agent': 'FocusFormsApp/1.0'
      }
    });

    if (response.data && response.data.display_name) {
      return response.data.display_name;
    }

    return `${lat}, ${lng}`;
  } catch (error) {
    console.error('Reverse geocoding error:', error.message);
    return `${lat}, ${lng}`; // Fallback to coordinates
  }
};
