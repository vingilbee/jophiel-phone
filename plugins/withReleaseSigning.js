// Signs release builds with Jophiel's own key instead of the debug key that prebuild puts there.
// The key and its passwords live outside the repo in ~/.jophiel-release/ (keystore.properties holds
// JOPHIEL_RELEASE_STORE_FILE, _KEY_ALIAS, _STORE_PASSWORD, _KEY_PASSWORD); Gradle reads them at build
// time, so no secret is written into android/. Without that file a release build fails rather than
// quietly falling back to the debug key. Losing the key means the installed app can't be updated.
const { withAppBuildGradle } = require('expo/config-plugins')

const MARKER = '// jophiel-release-signing'

const LOAD = `${MARKER}
def jophielSigning = new Properties()
def jophielSigningFile = new File(System.getProperty('user.home'), '.jophiel-release/keystore.properties')
if (jophielSigningFile.exists()) {
    jophielSigningFile.withInputStream { jophielSigning.load(it) }
}
`

const RELEASE_CONFIG = `
        release {
            if (jophielSigningFile.exists()) {
                storeFile file(jophielSigning['JOPHIEL_RELEASE_STORE_FILE'])
                storePassword jophielSigning['JOPHIEL_RELEASE_STORE_PASSWORD']
                keyAlias jophielSigning['JOPHIEL_RELEASE_KEY_ALIAS']
                keyPassword jophielSigning['JOPHIEL_RELEASE_KEY_PASSWORD']
            }
        }`

function addReleaseSigning(gradle) {
  if (gradle.includes(MARKER)) return gradle

  const android = gradle.indexOf('\nandroid {')
  const debugConfig = /(signingConfigs\s*\{\s*debug\s*\{[^}]*\})/
  const releaseUsesDebug = /(release\s*\{[^}]*?)signingConfig signingConfigs\.debug/
  if (android < 0 || !debugConfig.test(gradle) || !releaseUsesDebug.test(gradle)) {
    throw new Error('withReleaseSigning: app/build.gradle no longer has the expected signing blocks')
  }

  return (gradle.slice(0, android + 1) + LOAD + gradle.slice(android + 1))
    .replace(debugConfig, `$1${RELEASE_CONFIG}`)
    .replace(releaseUsesDebug, '$1signingConfig signingConfigs.release')
}

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    cfg.modResults.contents = addReleaseSigning(cfg.modResults.contents)
    return cfg
  })
}
