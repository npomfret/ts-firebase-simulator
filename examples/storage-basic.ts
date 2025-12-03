/**
 * Basic Storage operations
 */

import { StubStorage } from 'ts-firebase-simulator';

async function main() {
    // In this example, use StubStorage directly (not the interface) to access test helper methods like getFile()
    const storage = new StubStorage({ defaultBucketName: 'my-bucket' });

    // Upload a file
    const bucket = storage.bucket();
    const file = bucket.file('images/photo.jpg');

    await file.save(Buffer.from('fake image data'), {
        metadata: {
            contentType: 'image/jpeg',
        },
    });

    // Make it public
    await file.makePublic();

    // Check the stored file
    const stored = storage.getFile('my-bucket', 'images/photo.jpg');
    console.log('File path:', stored?.path);
    console.log('Content type:', stored?.metadata?.contentType);
    console.log('Is public:', stored?.public);
    console.log('Size:', stored?.size, 'bytes');

    // Delete the file
    await file.delete();
    console.log('After delete:', storage.getFile('my-bucket', 'images/photo.jpg'));
}

main().catch(console.error);
