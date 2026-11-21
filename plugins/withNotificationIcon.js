// Writes Jophiel's ✦ as a vector drawable (res/drawable/ic_stat_jophiel.xml) for the status-bar
// notification icon. Android tints it; a full-color launcher icon would show as a white square.
const { withDangerousMod } = require('expo/config-plugins')
const fs = require('fs')
const path = require('path')

const STAR = `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp"
    android:viewportWidth="1024" android:viewportHeight="1024">
  <path android:fillColor="#FFFFFFFF"
      android:pathData="M512,96 C552,368 656,472 928,512 C656,552 552,656 512,928 C472,656 368,552 96,512 C368,472 472,368 512,96 Z"/>
</vector>
`

module.exports = function withNotificationIcon(config) {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const dir = path.join(cfg.modRequest.platformProjectRoot, 'app/src/main/res/drawable')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'ic_stat_jophiel.xml'), STAR)
      return cfg
    },
  ])
}
