import React, { useEffect, useState, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  Animated,
  PermissionsAndroid,
  Platform,
  SafeAreaView,
  Pressable,
  StatusBar,
  I18nManager
} from 'react-native';

// Mathematically lock the app to Left-To-Right (LTR) specifically to prevent UI inversion on RTL devices.
try {
  I18nManager.allowRTL(false);
  I18nManager.forceRTL(false);
} catch (e) {}

import AsyncStorage from '@react-native-async-storage/async-storage';
import Slider from '@react-native-community/slider';
import { Audio } from 'expo-av';
import * as Haptics from 'expo-haptics';
import notifee, { AndroidImportance } from '@notifee/react-native';

const COLORS = {
  background: '#FCF8F5',
  cardBackground: '#FCF0E3',
  primaryText: '#6C4F69',
  secondaryText: '#7A6B74',
  ringLines: '#EFE0E4',
  trackActive: '#F6D2F6',
  trackInactive: '#BDB3BA',
  thumb: '#6C4F69',
  sliderTrackBg: '#EFE5EB',
  warningText: '#E63946',
};

const STORAGE_KEYS = {
  MONITORING: '@shush_monitoring',
  THRESHOLD: '@shush_threshold',
};

// -- Foreground Service Registration (Headless) --
notifee.registerForegroundService((notification) => {
  return new Promise(() => {
    // Keeps service alive globally
  });
});

// -- Custom Components --
const WaveIcon = () => (
  <View style={styles.waveContainer}>
    <View style={[styles.waveLine, { height: 6 }]} />
    <View style={[styles.waveLine, { height: 12 }]} />
    <View style={[styles.waveLine, { height: 18 }]} />
    <View style={[styles.waveLine, { height: 8 }]} />
  </View>
);

const CustomSwitch = ({ value, onValueChange }: { value: boolean, onValueChange: (v: boolean) => void }) => {
  const thumbAnim = useRef(new Animated.Value(value ? 22 : 0)).current;

  useEffect(() => {
    Animated.spring(thumbAnim, {
      toValue: value ? 22 : 0,
      useNativeDriver: true,
      friction: 6,
      tension: 40,
    }).start();
  }, [value, thumbAnim]);

  return (
    <Pressable onPress={() => onValueChange(!value)} hitSlop={10}>
      <View style={[styles.switchTrack, { backgroundColor: value ? COLORS.trackActive : COLORS.trackInactive }]}>
        <Animated.View style={[styles.switchThumb, { transform: [{ translateX: thumbAnim }] }]} />
      </View>
    </Pressable>
  );
};


// -- Main App --

export default function App() {
  const [isMonitoringEnabled, setIsMonitoringEnabled] = useState(false);
  const [volumeThreshold, setVolumeThreshold] = useState(75);
  const [isLoaded, setIsLoaded] = useState(false);
  const [displayDb, setDisplayDb] = useState(0);
  const [isWarning, setIsWarning] = useState(false);

  // Animation & Throttling
  const animatedOuterScale = useRef(new Animated.Value(1)).current;
  const animatedInnerScale = useRef(new Animated.Value(1)).current;
  const lastUpdateRef = useRef(0);

  // Haptics & Warning State Sync
  const volumeThresholdRef = useRef(volumeThreshold);
  useEffect(() => {
    volumeThresholdRef.current = volumeThreshold;
  }, [volumeThreshold]);

  const lastHapticTimeRef = useRef(0);
  const isWarningRef = useRef(false);

  // Initial Setup
  useEffect(() => {
    const requestPermissions = async () => {
      if (Platform.OS === 'android') {
        try {
          const permissionsToRequest = [
            PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
            PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE,
          ];
          if (Platform.Version >= 33) {
            permissionsToRequest.push(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
          }
          await PermissionsAndroid.requestMultiple(permissionsToRequest);
        } catch (err) {
          console.warn('Failed to request permissions', err);
        }
      }
    };

    const loadState = async () => {
      try {
        const storedMonitoring = await AsyncStorage.getItem(STORAGE_KEYS.MONITORING);
        const storedThreshold = await AsyncStorage.getItem(STORAGE_KEYS.THRESHOLD);

        if (storedMonitoring !== null) {
          setIsMonitoringEnabled(storedMonitoring === 'true');
        }
        if (storedThreshold !== null) {
          setVolumeThreshold(parseInt(storedThreshold, 10));
        }
      } catch (e) {
        console.error('Failed to load state', e);
      } finally {
        setIsLoaded(true);
      }
    };

    requestPermissions();
    loadState();
  }, []);

  // Foreground Service & Audio Engine Orchestration
  useEffect(() => {
    let recording: Audio.Recording | null = null;
    let isMounted = true;
    
    // Core Logic: Simply map directly to the User's Master Toggle.
    const shouldMonitor = isMonitoringEnabled;

    const startRecordingAndService = async () => {
      try {
        // 1. Kickstart Notification & Foreground Service to protect mic thread
        const channelId = await notifee.createChannel({
          id: 'shush_foreground',
          name: 'SHUSH Background Monitoring',
          importance: AndroidImportance.LOW, // Avoids sound/popups on Android 8+
        });
        
        await notifee.displayNotification({
          id: 'shush_monitoring_notification',
          title: 'SHUSH',
          body: 'Monitoring call volume...',
          android: {
            channelId,
            asForegroundService: true,
            ongoing: true,
          },
        });

        // 2. Start Hardware Mic
        const permission = await Audio.requestPermissionsAsync();
        if (permission.status !== 'granted') return;

        await Audio.setAudioModeAsync({
          allowsRecordingIOS: true,
          playsInSilentModeIOS: true,
        });

        // Optimize audio source for Dialer apps
        const CUSTOM_AUDIO_OPTIONS = {
          ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
          android: {
            ...Audio.RecordingOptionsPresets.HIGH_QUALITY.android,
            // 7 = MediaRecorder.AudioSource.VOICE_COMMUNICATION
            audioSource: 7, 
          }
        };

        const { recording: newRecording } = await Audio.Recording.createAsync(
          CUSTOM_AUDIO_OPTIONS,
          (status) => {
            if (!isMounted) return;
            if (status.isRecording && status.metering !== undefined) {
              const linearVolume160 = Math.max(0, status.metering + 160);

              // Throttle text
              const now = Date.now();
              const UPDATE_INTERVAL_MS = 300; 
              if (now - lastUpdateRef.current > UPDATE_INTERVAL_MS) {
                setDisplayDb(Math.round(linearVolume160));
                lastUpdateRef.current = now;
              }

              // Warning & Haptics Logic
              const isOverThreshold = linearVolume160 > volumeThresholdRef.current;
              
              if (isOverThreshold !== isWarningRef.current) {
                setIsWarning(isOverThreshold);
                isWarningRef.current = isOverThreshold;
              }

              if (isOverThreshold) {
                const nowTimestamp = Date.now();
                if (nowTimestamp - lastHapticTimeRef.current > 3000) {
                  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
                  lastHapticTimeRef.current = nowTimestamp;
                }
              }

              // Animate Rings
              const targetScale = 1 + (linearVolume160 / 160) * 0.3;
              Animated.spring(animatedOuterScale, {
                toValue: targetScale,
                useNativeDriver: true,
                friction: 5,
                tension: 40,
              }).start();

              Animated.spring(animatedInnerScale, {
                toValue: targetScale * 0.95,
                useNativeDriver: true,
                friction: 6,
                tension: 30,
              }).start();
            }
          },
          50
        );

        if (isMounted) {
          recording = newRecording;
        } else {
          await newRecording.stopAndUnloadAsync();
        }
      } catch (err) {
        console.error('Failed to start recording/service setup', err);
      }
    };

    const stopRecordingAndService = async () => {
      // 1. Stop mic
      if (recording) {
        try {
          await recording.stopAndUnloadAsync();
        } catch (err) {}
        recording = null;
      }
      
      // 2. Kill Foreground Service & Notification
      try {
        await notifee.stopForegroundService();
      } catch (e) {}

      // UI reset
      setDisplayDb(0);
      if (isWarningRef.current) {
        setIsWarning(false);
        isWarningRef.current = false;
      }
      Animated.spring(animatedOuterScale, { toValue: 1, useNativeDriver: true }).start();
      Animated.spring(animatedInnerScale, { toValue: 1, useNativeDriver: true }).start();
    };

    if (shouldMonitor) {
      startRecordingAndService();
    } else {
      stopRecordingAndService();
    }

    return () => {
      isMounted = false;
      stopRecordingAndService();
    };
  }, [isMonitoringEnabled, animatedOuterScale, animatedInnerScale]);

  const handleToggle = async (value: boolean) => {
    setIsMonitoringEnabled(value);
    await AsyncStorage.setItem(STORAGE_KEYS.MONITORING, value.toString());
  };

  const handleSliderChange = async (value: number) => {
    const roundedValue = Math.round(value);
    setVolumeThreshold(roundedValue);
    await AsyncStorage.setItem(STORAGE_KEYS.THRESHOLD, roundedValue.toString());
  };

  if (!isLoaded) return null;

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <WaveIcon />
          <Text style={styles.title}>SHUSH</Text>
        </View>

        {/* Visualizer Section */}
        <View style={styles.visualizerSection}>
          <Text style={styles.inputLevelText}>INPUT LEVEL</Text>
          <View style={styles.circleContainer}>
            <Animated.View style={[styles.outerRing, { transform: [{ scale: animatedOuterScale }] }]} />
            <Animated.View style={[styles.innerRing, { transform: [{ scale: animatedInnerScale }] }]} />
            
            <Text style={[styles.dbNumberText, isWarning && styles.warningText]}>{displayDb}</Text>
            <Text style={[styles.dbLabelText, isWarning && styles.warningText]}>dB</Text>
          </View>
        </View>

        {/* Monitor Volume Card */}
        <View style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <View style={{ flex: 1, paddingRight: 10 }}>
              <Text style={styles.cardTitle}>Monitor Volume</Text>
              <Text style={styles.cardDescription}>
                Automatically adjust output{'\n'}levels based on environmental{'\n'}noise.
              </Text>
            </View>
          </View>
          <View style={styles.toggleRow}>
            <CustomSwitch value={isMonitoringEnabled} onValueChange={handleToggle} />
          </View>
        </View>

        {/* Threshold Card */}
        <View 
          style={[styles.card, !isMonitoringEnabled && styles.disabledCard]} 
          pointerEvents={isMonitoringEnabled ? 'auto' : 'none'}
        >
          <View style={styles.cardHeaderRow}>
            <View>
              <Text style={styles.cardTitle}>Threshold</Text>
              <Text style={styles.cardSubtitle}>SILENCE TRIGGER</Text>
            </View>
            <Text style={styles.percentageText}>{volumeThreshold} dB</Text>
          </View>

          <View style={styles.sliderContainer}>
            <Slider
              style={styles.slider}
              minimumValue={0}
              maximumValue={160}
              step={1}
              value={volumeThreshold}
              onSlidingComplete={handleSliderChange}
              onValueChange={(val) => setVolumeThreshold(val)}
              minimumTrackTintColor={COLORS.trackActive}
              maximumTrackTintColor={COLORS.sliderTrackBg}
              thumbTintColor={COLORS.thumb}
            />
            <View style={styles.sliderLabels}>
              <Text style={styles.sliderLabelText}>MIN</Text>
              <Text style={styles.sliderLabelText}>MAX</Text>
            </View>
          </View>
        </View>

      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.background,
    paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0,
  },
  container: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: 40,
    backgroundColor: COLORS.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 40,
  },
  waveContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 10,
    height: 24,
    justifyContent: 'center',
  },
  waveLine: {
    width: 2,
    backgroundColor: COLORS.primaryText,
    marginHorizontal: 1.5,
    borderRadius: 2,
  },
  title: {
    fontSize: 20,
    fontWeight: '800',
    color: COLORS.primaryText,
    letterSpacing: 0.5,
  },
  visualizerSection: {
    alignItems: 'center',
    marginBottom: 20,
  },
  inputLevelText: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 2.5,
    color: '#7D6A71',
    marginBottom: 24,
  },
  circleContainer: {
    width: 220,
    height: 220,
    alignItems: 'center',
    justifyContent: 'center',
  },
  outerRing: {
    position: 'absolute',
    width: 220,
    height: 220,
    borderRadius: 110,
    borderWidth: 1.5,
    borderColor: '#F3E8EC',
  },
  innerRing: {
    position: 'absolute',
    width: 190,
    height: 190,
    borderRadius: 95,
    borderWidth: 1,
    borderColor: '#EFE0E5',
  },
  dbNumberText: {
    fontSize: 72,
    fontWeight: '300',
    color: COLORS.primaryText,
    lineHeight: 80,
    includeFontPadding: false,
  },
  dbLabelText: {
    fontSize: 14,
    fontWeight: '500',
    color: COLORS.primaryText,
    marginTop: -4,
  },
  warningText: {
    color: COLORS.warningText,
    fontWeight: '700',
  },
  statusHelperText: {
    fontSize: 14,
    color: COLORS.secondaryText,
    textAlign: 'center',
    marginBottom: 20,
    fontStyle: 'italic',
  },
  card: {
    backgroundColor: COLORS.cardBackground,
    borderRadius: 20,
    padding: 24,
    marginBottom: 20,
  },
  disabledCard: {
    opacity: 0.45,
  },
  cardHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.primaryText,
    marginBottom: 6,
  },
  cardSubtitle: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
    color: '#655A55',
    marginTop: 2,
  },
  cardDescription: {
    fontSize: 14,
    color: COLORS.secondaryText,
    lineHeight: 22,
    marginTop: 8,
  },
  toggleRow: {
    marginTop: 16,
  },
  percentageText: {
    fontSize: 36,
    fontWeight: '300',
    color: COLORS.primaryText,
  },
  sliderContainer: {
    marginTop: 30,
  },
  slider: {
    width: '100%',
    height: 40,
  },
  sliderLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    marginTop: 4,
  },
  sliderLabelText: {
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 1.5,
    color: '#5B5354',
  },
  switchTrack: {
    width: 50,
    height: 28,
    borderRadius: 14,
    justifyContent: 'center',
    paddingHorizontal: 2,
  },
  switchThumb: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: COLORS.thumb,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 2,
    elevation: 2,
  },
});
