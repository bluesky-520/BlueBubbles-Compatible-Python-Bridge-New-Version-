import fs from 'fs';
import path from 'path';
import logger from '../config/logger.js';

export const getFcmClientConfig = () => {
  const configPath = process.env.FCM_GOOGLE_SERVICES_PATH;
  if (!configPath) {
    return fallbackGoogleServices();
  }

  try {
    const raw = fs.readFileSync(path.resolve(configPath), 'utf8');
    const parsed = JSON.parse(raw);

    if (parsed?.client?.[0] && !parsed.client[0].oauth_client) {
      const projectNumber =
        parsed?.project_info?.project_number ||
        parsed?.client?.[0]?.client_info?.mobilesdk_app_id?.split(':')?.[1] ||
        '0';
      parsed.client[0].oauth_client = [
        {
          client_id: projectNumber,
          client_type: 3
        }
      ];
    }

    return parsed;
  } catch (error) {
    logger.warn(`Failed to read FCM config: ${error.message}`);
    return fallbackGoogleServices();
  }
};

const fallbackGoogleServices = () => ({
  project_info: {
    project_number: '0',
    project_id: 'local-bridge',
    storage_bucket: ''
  },
  client: [
    {
      client_info: {
        mobilesdk_app_id: '0:0:local-bridge',
        android_client_info: {
          package_name: 'com.bluebubbles.bridge'
        }
      },
      api_key: [
        {
          current_key: ''
        }
      ],
      oauth_client: [
        {
          client_id: '0',
          client_type: 3
        }
      ]
    }
  ]
});
