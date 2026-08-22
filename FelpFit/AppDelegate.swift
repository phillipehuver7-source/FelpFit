import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.backgroundColor = UIColor(red: 9 / 255, green: 9 / 255, blue: 14 / 255, alpha: 1)
        window.rootViewController = FelpFitViewController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}

