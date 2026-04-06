import ePub from 'epubjs';

export async function extractMetadata(file: File) {
  const arrayBuffer = await file.arrayBuffer();
  const book = ePub(arrayBuffer);
  
  try {
    const metadata = await book.loaded.metadata;
    const coverUrl = await book.coverUrl();
    
    // Convert cover URL to base64 if possible, or just use it if it's a blob
    let coverBase64 = null;
    if (coverUrl) {
      try {
        const response = await fetch(coverUrl);
        const blob = await response.blob();
        coverBase64 = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.readAsDataURL(blob);
        });
      } catch (e) {
        console.error("Failed to convert cover to base64", e);
      }
    }

    return {
      title: metadata.title || file.name.replace('.epub', ''),
      author: metadata.creator || 'Unknown Author',
      cover: coverBase64,
      data: arrayBuffer,
    };
  } catch (error) {
    console.error("Error extracting metadata:", error);
    return {
      title: file.name.replace('.epub', ''),
      author: 'Unknown Author',
      cover: null,
      data: arrayBuffer,
    };
  } finally {
    book.destroy();
  }
}
