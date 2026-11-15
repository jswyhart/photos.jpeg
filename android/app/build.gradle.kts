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
        versionCode = 2
        versionName = "2.0.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Uses the debug key so `assembleRelease` produces an installable APK out of the box.
            // Replace with your own signingConfig before publishing to Google Play.
            signingConfig = signingConfigs.getByName("debug")
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
