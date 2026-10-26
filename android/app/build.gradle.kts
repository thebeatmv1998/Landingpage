plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.homedeck.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.homedeck.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 6
        versionName = "1.1.4"
    }

    signingConfigs {
        create("release") {
            val storePath = System.getenv("HOMEDECK_KEYSTORE")
            val storePass = System.getenv("HOMEDECK_KEYSTORE_PASSWORD")
            val alias = System.getenv("HOMEDECK_KEY_ALIAS") ?: "homedeck"
            val keyPass = System.getenv("HOMEDECK_KEY_PASSWORD") ?: storePass
            if (!storePath.isNullOrBlank() && !storePass.isNullOrBlank()) {
                storeFile = file(storePath)
                storePassword = storePass
                keyAlias = alias
                keyPassword = keyPass
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
}
