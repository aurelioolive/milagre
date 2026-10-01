import { useEffect, useRef, useState } from "react";
import type { ClipboardEvent } from "react";
import type { ImageAttachment } from "../model";

const TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function readImage(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ id: crypto.randomUUID(), name: file.name || "Pasted image", dataUrl: String(reader.result) });
    reader.onerror = () => reject(new Error("Could not read the pasted image. Try again."));
    reader.readAsDataURL(file);
  });
}

export function usePastedImages(scope: string) {
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const reading = useRef(false);

  function clear() {
    generation.current++;
    reading.current = false;
    setImages([]);
    setLoading(false);
    setError("");
  }

  useEffect(() => {
    clear();
    return () => { generation.current++; };
  }, [scope]);

  async function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.items).filter((item) => item.kind === "file" && item.type.startsWith("image/")).map((item) => item.getAsFile()).filter((file): file is File => file !== null);
    if (!files.length) return;
    event.preventDefault();
    setError("");
    if (reading.current) { setError("Wait for the current image to finish loading, then paste again."); return; }
    if (files.some((file) => !TYPES.has(file.type))) { setError("Use PNG, JPEG, WebP, or GIF images."); return; }
    if (files.some((file) => file.size > 5 * 1024 * 1024)) { setError("Each image must be 5 MB or smaller."); return; }
    if (images.length + files.length > 4) { setError("Attach up to 4 images per message."); return; }
    const current = generation.current;
    reading.current = true;
    setLoading(true);
    try {
      const next = await Promise.all(files.map(readImage));
      if (current === generation.current) setImages((existing) => [...existing, ...next]);
    } catch (error) {
      if (current === generation.current) setError(error instanceof Error ? error.message : "Could not read image.");
    } finally {
      if (current === generation.current) { reading.current = false; setLoading(false); }
    }
  }

  return { images, loading, error, onPaste, clear, remove: (id: string) => setImages((current) => current.filter((image) => image.id !== id)) };
}

export type ImageDraft = ReturnType<typeof usePastedImages>;
