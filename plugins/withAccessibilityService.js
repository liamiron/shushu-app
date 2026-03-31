const {
  withAndroidManifest,
  withDangerousMod,
  AndroidConfig,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const withAccessibilityService = (config) => {
  // 1. Modify AndroidManifest.xml
  config = withAndroidManifest(config, (config) => {
    const mainApplication = AndroidConfig.Manifest.getMainApplicationOrThrow(config.modResults);

    // Add service array if not present
    if (!mainApplication.service) {
      mainApplication.service = [];
    }

    // Prevent duplicates if running prebuild multiple times
    const hasService = mainApplication.service.some(
      (s) => s.$['android:name'] === '.ShushAccessibilityService'
    );

    if (!hasService) {
      mainApplication.service.push({
        $: {
          'android:name': '.ShushAccessibilityService',
          'android:permission': 'android.permission.BIND_ACCESSIBILITY_SERVICE',
          'android:exported': 'true',
        },
        'intent-filter': [
          {
            action: [
              {
                $: {
                  'android:name': 'android.accessibilityservice.AccessibilityService',
                },
              },
            ],
          },
        ],
        'meta-data': [
          {
            $: {
              'android:name': 'android.accessibilityservice',
              'android:resource': '@xml/accessibility_service_config',
            },
          },
        ],
      });
    }

    return config;
  });

  // 2. Generate raw Java and XML files during prebuild
  config = withDangerousMod(config, [
    'android',
    async (config) => {
      const projectRoot = config.modRequest.projectRoot;
      // Define specific destination directories deep inside the Android structure
      const resDir = path.join(projectRoot, 'android/app/src/main/res/xml');
      const packagePath = config.android.package.replace(/\./g, '/');
      const javaDir = path.join(projectRoot, 'android/app/src/main/java', packagePath);

      // Create directories securely
      fs.mkdirSync(resDir, { recursive: true });
      fs.mkdirSync(javaDir, { recursive: true });

      // Build XML Config Content for the internal Accessibility engine
      const xmlContent = `<?xml version="1.0" encoding="utf-8"?>
<accessibility-service xmlns:android="http://schemas.android.com/apk/res/android"
    android:accessibilityEventTypes="typeAllMask"
    android:accessibilityFlags="flagDefault"
    android:accessibilityFeedbackType="feedbackSpoken"
    android:notificationTimeout="100"
    android:canRetrieveWindowContent="true"
    android:description="@string/app_name"
/>`;

      // Build pure Native Java logic for the actual Service Class
      const javaContent = `package ${config.android.package};

import android.accessibilityservice.AccessibilityService;
import android.view.accessibility.AccessibilityEvent;
import android.util.Log;

public class ShushAccessibilityService extends AccessibilityService {
    private static final String TAG = "ShushAccessibilityService";

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // We do not need to process exact screen reading events!
        // The service's mere existence and PID registration is what grants the Audio Focus exemptions.
    }

    @Override
    public void onInterrupt() {
        Log.d(TAG, "Service Interrupted");
    }

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        Log.d(TAG, "ShushAccessibilityService Connected securely!");
    }
}`;

      // Write files
      fs.writeFileSync(path.join(resDir, 'accessibility_service_config.xml'), xmlContent);
      fs.writeFileSync(path.join(javaDir, 'ShushAccessibilityService.java'), javaContent);

      return config;
    },
  ]);

  return config;
};

module.exports = withAccessibilityService;
