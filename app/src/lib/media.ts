import { File } from "expo-file-system"
import { ImageManipulator, SaveFormat } from "expo-image-manipulator"
import * as ImagePicker from "expo-image-picker"
import type { ImageUpload } from "@server/protocol"

/** A photo ready to send: a small JPEG, plus its local file for the preview. */
export interface Photo extends ImageUpload {
  uri: string
}

const MAX_SIDE = 1600

/** Take or pick a photo and shrink it, so it uploads quickly and stays under model limits. Null when cancelled. */
export async function pickPhoto(source: "camera" | "library"): Promise<Photo | null> {
  if (source === "camera") {
    const permission = await ImagePicker.requestCameraPermissionsAsync()
    if (!permission.granted) throw new PermissionError()
  }
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 1 }
  const result = source === "camera" ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options)
  const asset = result.canceled ? undefined : result.assets[0]
  if (!asset) return null
  const landscape = asset.width >= asset.height
  const context = ImageManipulator.manipulate(asset.uri)
  if (Math.max(asset.width, asset.height) > MAX_SIDE) context.resize(landscape ? { width: MAX_SIDE, height: null } : { width: null, height: MAX_SIDE })
  const image = await context.renderAsync()
  const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.8, base64: true })
  if (!saved.base64) return null
  return { uri: saved.uri, data: saved.base64, name: "photo.jpg" }
}

/** A recording's contents, for uploading. */
export function readBase64(uri: string): Promise<string> {
  return new File(uri).base64()
}

export class PermissionError extends Error {}
