fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap();
    if target_os != "windows" && target_os != "macos" {
        panic!(
            "flashfilter only supports Windows and macOS. \
             Current target OS: `{}`. \
             Linux and other platforms are not supported.",
            target_os
        );
    }

    if target_os == "macos" {
        // The screencapturekit crate links a Swift bridge that depends on
        // libswift_Concurrency.dylib via @rpath.  On modern macOS this dylib
        // lives only inside the Xcode / CLT toolchain (not in the OS dyld
        // cache), so we must embed the correct rpath in the final binary.
        //
        // cargo:rustc-link-arg must pass -rpath and its value as two
        // *separate* arguments because Rust invokes the linker directly (not
        // through a cc driver), so the -Wl, quoting used by screencapturekit's
        // own build.rs has no effect.

        // Point @rpath/libswift_Concurrency.dylib at the OS copy in the dyld
        // shared cache (/usr/lib/swift/), which is the same image that all
        // other Swift dylibs already reference.  This avoids the duplicate-
        // class warnings that occur when the toolchain's swift-5.5 copy is
        // loaded alongside the system copy.
        //
        // Note: cargo:rustc-link-arg passes each token as a *separate*
        // argument to the linker (ld64), so -rpath and its path must be two
        // separate println! calls.
        println!("cargo:rustc-link-arg=-rpath");
        println!("cargo:rustc-link-arg=/usr/lib/swift");
    }
}
