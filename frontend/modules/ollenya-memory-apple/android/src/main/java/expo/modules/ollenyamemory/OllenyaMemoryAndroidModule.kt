package expo.modules.ollenyamemory

import android.net.Uri
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.IOException

class OllenyaMemoryAndroidModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("OllenyaMemoryAndroid")

    AsyncFunction("prepareDatabaseDirectory") {
      val context = appContext.reactContext ?: throw IOException("Android context unavailable")
      val directory = File(context.noBackupFilesDir, "OllenyaMemory")
      if (!directory.isDirectory && !directory.mkdirs() && !directory.isDirectory) {
        throw IOException("Cannot create the local memory directory")
      }
      Uri.fromFile(directory).toString()
    }
  }
}
