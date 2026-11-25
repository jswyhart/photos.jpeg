plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.photosjpeg.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.photosjpeg.android"
        minSdk = 29
        targetSdk = 35
        versionCode = 7
        versionName = "2.3.0"
    }

    // Your own release key: point PJ_KEYSTORE at the keystore file and give PJ_KEYSTORE_PASSWORD,
    // PJ_KEY_ALIAS and PJ_KEY_PASSWORD (environment variables; the release workflow fills them from
    // the repository's secrets). Without them `assembleRelease` uses the debug key, so it still
    // produces an installable APK — but not one to publish.
    val keystore = System.getenv("PJ_KEYSTORE")?.takeIf { it.isNotBlank() && file(it).exists() }
    signingConfigs {
        if (keystore != null) create("release") {
            storeFile = file(keystore)
            storePassword = System.getenv("PJ_KEYSTORE_PASSWORD")
            keyAlias = System.getenv("PJ_KEY_ALIAS")
            keyPassword = System.getenv("PJ_KEY_PASSWORD")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName(if (keystore != null) "release" else "debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    // The editor UI and engine are shared with the desktop apps (../../src).
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/webassets"))
}

val copyWebApp by tasks.registering(Sync::class) {
    from(rootProject.file("../src"))
    // gradle assembleRelease -Plite: leave the neural-network models out; the app downloads each on first use
    if (project.hasProperty("lite")) exclude("vendor/ml/*.onnx")
    into(layout.buildDirectory.dir("generated/webassets/web"))
}
tasks.named("preBuild") { dependsOn(copyWebApp) }

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.documentfile:documentfile:1.0.1")
}
